import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { env } from "@/config/env";
import type { PreviewRenderOptions } from "./previews.ffmpeg";

export function previewRenderSettings(): Omit<
  PreviewRenderOptions,
  "inputPath" | "outputPath" | "durationSeconds" | "hasAudio"
> {
  return {
    plan: {
      clipCount: env.PREVIEW_CLIP_COUNT,
      clipSeconds: env.PREVIEW_CLIP_SECONDS,
      maxCoverage: env.PREVIEW_MAX_COVERAGE,
    },
    height: env.PREVIEW_HEIGHT,
    crf: env.PREVIEW_CRF,
    preset: env.PREVIEW_PRESET,
    audioBitrateKbps: env.PREVIEW_AUDIO_BITRATE_KBPS,
  };
}

/**
 * Demo videos are few source files behind many catalog rows, and the demo
 * database resets from a baseline. Previews are therefore keyed by source file
 * on disk, with no demo table: one render serves every row that shares a file.
 */
export function demoPreviewPath(videoFilePath: string): string {
  const key = createHash("sha256")
    .update(basename(videoFilePath))
    .digest("hex")
    .slice(0, 24);
  return join(env.DEMO_ASSETS_DIR, "preview", `${key}.mp4`);
}
