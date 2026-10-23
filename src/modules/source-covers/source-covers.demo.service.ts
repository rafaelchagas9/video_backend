/**
 * Demo covers: local movie stills under `demo_mode/cover/`, assigned to videos
 * by `demo_mode/scene-credits.json` (see `ensureDemoSceneCredits`). A scan of
 * one of those scenes proposes the fixture's `candidates`, so the review can
 * compare a stored cover against sharper, duller and near-duplicate options.
 */

import { statSync } from "fs";
import sharp from "sharp";
import { API_PREFIX } from "@/config/constants";
import { demoRepository, resolveDemoAssetPath } from "@/database/demo";
import { demoSceneFixture } from "@/database/demo/scene-credits";
import type { VideoCover } from "./source-covers.types";

export interface DemoCoverRecord {
  file: string;
  source_url: string;
  width: number;
  height: number;
  file_size_bytes: number;
  fetched_at: string;
}

const KIND = "video-cover";

function fileName(file: string): string {
  return file.split("/").pop() ?? file;
}

class SourceCoversDemoService {
  private thumbs = new Map<string, Buffer>();

  record(videoId: number): DemoCoverRecord | null {
    return demoRepository.getResource(KIND, videoId) as DemoCoverRecord | null;
  }

  describe(videoId: number): VideoCover | null {
    const record = this.record(videoId);
    if (!record) return null;
    return {
      video_id: videoId,
      url: this.imageUrl(videoId, record.file),
      source_url: record.source_url,
      width: record.width,
      height: record.height,
      file_size_bytes: record.file_size_bytes,
      serves_thumbnail: record.width / record.height >= 1.2,
      fetched_at: record.fetched_at,
    };
  }

  /** Served URL for a cover file; the file name doubles as a cache key. */
  imageUrl(videoId: number, file: string): string {
    return `${API_PREFIX}/videos/${videoId}/cover/image?file=${encodeURIComponent(fileName(file))}`;
  }

  /** The stored cover, or a fixture candidate of this video when `file` names one. */
  resolveFile(videoId: number, file?: string): string | null {
    const scene = demoSceneFixture().find((item) => item.video_id === videoId);
    const current = this.record(videoId)?.file ?? null;
    const known = [current, scene?.cover, ...(scene?.candidates ?? [])].filter(
      (value): value is string => Boolean(value)
    );
    const match = file ? known.find((value) => fileName(value) === file) : current;
    return match ? resolveDemoAssetPath(match) : null;
  }

  /** Point the video at one of its known cover files (accepting a scan proposal). */
  async assign(videoId: number, sourceUrl: string): Promise<void> {
    const file = new URL(sourceUrl, "http://demo").searchParams.get("file");
    const path = file ? this.resolveFile(videoId, file) : null;
    if (!path || !file) return;
    const scene = demoSceneFixture().find((item) => item.video_id === videoId);
    const relative = [scene?.cover, ...(scene?.candidates ?? [])].find(
      (value) => value && fileName(value) === file
    );
    if (!relative) return;
    const meta = await sharp(path).metadata();
    demoRepository.putResource(KIND, videoId, {
      file: relative,
      source_url: sourceUrl,
      width: meta.width ?? 0,
      height: meta.height ?? 0,
      file_size_bytes: statSync(path).size,
      fetched_at: new Date().toISOString(),
    } satisfies DemoCoverRecord);
  }

  clear(videoId: number): void {
    demoRepository.deleteResource(KIND, videoId);
  }

  /** Landscape cover downscaled for the thumbnail route, or null when the frame should stay. */
  async thumbnail(videoId: number): Promise<Buffer | null> {
    const record = this.record(videoId);
    if (!record || record.width / record.height < 1.2) return null;
    const cached = this.thumbs.get(record.file);
    if (cached) return cached;
    const buffer = await sharp(resolveDemoAssetPath(record.file))
      .resize({ width: 1280, withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();
    this.thumbs.set(record.file, buffer);
    return buffer;
  }
}

export const sourceCoversDemoService = new SourceCoversDemoService();
