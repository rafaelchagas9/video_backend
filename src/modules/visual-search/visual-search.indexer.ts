import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { env } from "@/config/env";
import { resolveDemoAssetPath } from "@/database/demo/assets";
import {
  isPagedSpritePath,
  storyboardImagePaths,
  TILES_PER_PAGE,
  PAGE_COLUMNS,
} from "@/modules/storyboards/storyboards.pages";
import type { Storyboard } from "@/modules/storyboards/storyboards.types";
import { visualSearchClient, type StoryboardPageInput } from "./visual-search.client";
import type { FrameRow, IndexedVideo, VisualSearchStore } from "./visual-search.store";

/** Tiles per request: one full GPU batch is 64; ~16 pages keeps requests near 1–3 MB. */
const PAGES_PER_REQUEST = 16;

export class VisualIndexError extends Error {
  constructor(
    message: string,
    readonly code: "NO_STORYBOARD" | "STORYBOARD_FILES_MISSING" | "EMBEDDING_FAILED"
  ) {
    super(message);
  }
}

/** Cue start times from a storyboard VTT, one per tile in order. */
export function cueStarts(vtt: string): number[] {
  const starts: number[] = [];
  for (const line of vtt.split("\n")) {
    const match = /^(\d+):(\d{2}):(\d{2})\.(\d{3})\s+-->/.exec(line.trim());
    if (match)
      starts.push(
        Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000
      );
  }
  return starts;
}

function resolvePath(path: string): string {
  return env.DEMO_MODE ? resolveDemoAssetPath(path, { mustExist: true }) : path;
}

/**
 * Embed every tile of a video's storyboard and store the vectors. The storyboard is the
 * unit of freshness: regenerating it (new generated_at) makes the index stale.
 */
export async function indexStoryboard(
  store: VisualSearchStore,
  storyboard: Storyboard,
  signal?: AbortSignal
): Promise<IndexedVideo> {
  const imagePaths = storyboardImagePaths(storyboard.sprite_path, storyboard.tile_count);
  const paged = isPagedSpritePath(storyboard.sprite_path);
  let vtt = "";
  try {
    vtt = await readFile(resolvePath(storyboard.vtt_path), "utf-8");
  } catch {
    // fall back to the nominal interval below
  }
  const starts = cueStarts(vtt);
  const timestampOf = (index: number) =>
    starts[index] ?? index * storyboard.interval_seconds;

  const pages: (StoryboardPageInput & { firstTile: number })[] = [];
  for (const [pageIndex, path] of imagePaths.entries()) {
    let image: Uint8Array;
    try {
      image = await readFile(resolvePath(path));
    } catch {
      throw new VisualIndexError(
        `Storyboard image is missing: ${basename(path)}`,
        "STORYBOARD_FILES_MISSING"
      );
    }
    const firstTile = paged ? pageIndex * TILES_PER_PAGE : 0;
    const count = paged
      ? Math.min(TILES_PER_PAGE, storyboard.tile_count - firstTile)
      : storyboard.tile_count;
    if (count <= 0) continue;
    pages.push({
      id: String(pageIndex),
      image,
      fileName: basename(path),
      tileWidth: storyboard.tile_width,
      tileHeight: storyboard.tile_height,
      columns: paged ? PAGE_COLUMNS : 0,
      count,
      firstTile,
    });
  }

  const frames: FrameRow[] = [];
  let modelRevision = "";
  for (let offset = 0; offset < pages.length; offset += PAGES_PER_REQUEST) {
    signal?.throwIfAborted();
    const batch = pages.slice(offset, offset + PAGES_PER_REQUEST);
    const result = await visualSearchClient.embedPages(batch, signal);
    if (result.errors.length)
      throw new VisualIndexError(
        `Vision service could not read ${result.errors.length} storyboard page(s): ${result.errors[0]!.code}`,
        "EMBEDDING_FAILED"
      );
    modelRevision = result.modelRevision;
    for (const page of batch) {
      const vectors = result.pages.get(page.id);
      if (!vectors) throw new VisualIndexError("Missing page embeddings", "EMBEDDING_FAILED");
      for (let tile = 0; tile < page.count; tile++) {
        const frameIndex = page.firstTile + tile;
        frames.push({
          frameIndex,
          timestampSeconds: timestampOf(frameIndex),
          vector: vectors.subarray(tile * result.dimension, (tile + 1) * result.dimension),
        });
      }
    }
  }

  const meta: IndexedVideo = {
    videoId: storyboard.video_id,
    modelRevision,
    storyboardGeneratedAt: new Date(storyboard.generated_at),
    intervalSeconds: storyboard.interval_seconds,
    frameCount: frames.length,
  };
  signal?.throwIfAborted();
  await store.replaceVideo(meta, frames);
  return meta;
}
