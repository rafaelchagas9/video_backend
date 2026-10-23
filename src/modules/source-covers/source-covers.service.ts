/**
 * Scene covers from ThePornDB / StashDB, kept on disk.
 *
 * Accepting a scene's cover only stored its remote URL (`cover_image_url`
 * metadata). Those covers are often far sharper than the 640×480 ffmpeg
 * thumbnail and the frame artwork is cut from, so the cover is downloaded once
 * and becomes the preferred source for artwork variants and the thumbnail
 * route. The metadata row stays the source of truth: `sync` makes the stored
 * file follow it, whether a cover was accepted, replaced, or cleared.
 */

import { createHash } from "crypto";
import { mkdir, unlink, writeFile } from "fs/promises";
import { join } from "path";
import { and, eq } from "drizzle-orm";
import sharp from "sharp";
import { API_PREFIX } from "@/config/constants";
import { db } from "@/config/drizzle";
import { env } from "@/config/env";
import { videoMetadataTable, videoSourceCoversTable } from "@/database/schema";
import { loadEnrichmentImage } from "@/modules/enrichment/enrichment.images";
import { RASTER_ARTWORK_VARIANTS } from "@/modules/artwork/artwork.types";
import { logger } from "@/utils/logger";
import { sourceCoversDemoService } from "./source-covers.demo.service";
import type { VideoCover } from "./source-covers.types";

const COVER_KEY = "cover_image_url";
/** Wider than this reads as a frame; taller covers are posters and never stand in for a thumbnail. */
const THUMB_MIN_ASPECT = 1.2;
const THUMB_WIDTH = 1280;

type CoverRow = typeof videoSourceCoversTable.$inferSelect;

function coversDir(): string {
  return join(env.ARTWORK_DIR, "covers");
}

class SourceCoversService {
  /** One sync per video at a time; accepting two covers back to back must not race. */
  private chains = new Map<number, Promise<unknown>>();

  async get(videoId: number): Promise<CoverRow | null> {
    if (env.DEMO_MODE) return null;
    return db
      .select()
      .from(videoSourceCoversTable)
      .where(eq(videoSourceCoversTable.videoId, videoId))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  /** What the video currently shows: its stored cover, or nothing (the frame). */
  async describe(videoId: number): Promise<VideoCover | null> {
    if (env.DEMO_MODE) return sourceCoversDemoService.describe(videoId);
    const row = await this.get(videoId);
    return row
      ? {
          video_id: videoId,
          url: `${API_PREFIX}/videos/${videoId}/cover/image?h=${row.contentHash}`,
          source_url: row.sourceUrl,
          width: row.width,
          height: row.height,
          file_size_bytes: row.fileSizeBytes,
          serves_thumbnail: row.thumbPath !== null,
          fetched_at: row.fetchedAt.toISOString(),
        }
      : null;
  }

  /** Source image for artwork generation. */
  async artworkSource(videoId: number) {
    const row = await this.get(videoId);
    return row
      ? { path: row.filePath, width: row.width, height: row.height }
      : null;
  }

  /** Fire-and-forget form for request paths; failures only cost the upgrade. */
  scheduleSync(videoId: number): void {
    if (env.DEMO_MODE) return;
    void this.sync(videoId).catch((error) =>
      logger.warn({ error, videoId }, "Source cover sync failed")
    );
  }

  /**
   * Make the stored cover match `cover_image_url`. Returns true when artwork
   * was queued for regeneration.
   */
  sync(videoId: number, options: { regenerate?: boolean } = {}): Promise<boolean> {
    const previous = this.chains.get(videoId) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(() => this.syncNow(videoId, options.regenerate ?? true));
    this.chains.set(videoId, next);
    void next.finally(() => {
      if (this.chains.get(videoId) === next) this.chains.delete(videoId);
    });
    return next;
  }

  private async syncNow(videoId: number, regenerate: boolean): Promise<boolean> {
    const [meta, current] = await Promise.all([
      db
        .select({ value: videoMetadataTable.value })
        .from(videoMetadataTable)
        .where(
          and(
            eq(videoMetadataTable.videoId, videoId),
            eq(videoMetadataTable.key, COVER_KEY)
          )
        )
        .limit(1)
        .then((rows) => rows[0]?.value?.trim() || null),
      this.get(videoId),
    ]);

    if (meta === (current?.sourceUrl ?? null)) return false;

    if (!meta) {
      await db
        .delete(videoSourceCoversTable)
        .where(eq(videoSourceCoversTable.videoId, videoId));
      if (current) await this.removeFiles(current);
    } else {
      const stored = await this.download(videoId, meta);
      await db
        .insert(videoSourceCoversTable)
        .values({ videoId, sourceUrl: meta, ...stored })
        .onConflictDoUpdate({
          target: videoSourceCoversTable.videoId,
          set: { sourceUrl: meta, ...stored, fetchedAt: new Date() },
        });
      if (current) await this.removeFiles(current, stored);
    }

    if (!regenerate) return false;
    // Imported lazily: the artwork service reads covers through this module.
    const { artworkService } = await import("@/modules/artwork/artwork.service");
    await artworkService.requestGeneration(videoId, {
      variants: [...RASTER_ARTWORK_VARIANTS],
      force: true,
    });
    return true;
  }

  private async download(videoId: number, url: string) {
    const bytes = await loadEnrichmentImage(url);
    // Bake EXIF orientation in so every consumer can trust width/height.
    const image = sharp(bytes, { limitInputPixels: 100_000_000 }).rotate();
    const { data, info } = await image.toBuffer({ resolveWithObject: true });
    const format = info.format === "png" || info.format === "webp" ? info.format : "jpeg";
    const original =
      format === "jpeg" ? await sharp(data).jpeg({ quality: 95 }).toBuffer() : data;
    const contentHash = createHash("sha256").update(original).digest("hex").slice(0, 16);

    await mkdir(coversDir(), { recursive: true });
    const extension = format === "jpeg" ? "jpg" : format;
    const filePath = join(coversDir(), `video-${videoId}-${contentHash}.${extension}`);
    await writeFile(filePath, original);

    let thumbPath: string | null = null;
    if (info.width / info.height >= THUMB_MIN_ASPECT) {
      thumbPath = join(coversDir(), `video-${videoId}-${contentHash}-thumb.webp`);
      await writeFile(
        thumbPath,
        await sharp(original)
          .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
          .webp({ quality: 82 })
          .toBuffer()
      );
    }

    return {
      filePath,
      thumbPath,
      width: info.width,
      height: info.height,
      fileSizeBytes: original.byteLength,
      contentHash,
    };
  }

  private async removeFiles(
    row: Pick<CoverRow, "filePath" | "thumbPath">,
    keep?: { filePath: string; thumbPath: string | null }
  ): Promise<void> {
    for (const path of [row.filePath, row.thumbPath]) {
      if (!path || path === keep?.filePath || path === keep?.thumbPath) continue;
      await unlink(path).catch(() => {});
    }
  }
}

export const sourceCoversService = new SourceCoversService();
