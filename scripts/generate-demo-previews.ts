/**
 * Pre-render hover previews for demo mode.
 *
 * Demo catalog rows share a small set of source files, so previews are keyed by
 * source file (see `demoPreviewPath`) and rendered once per file. Existing
 * previews are kept unless `--force` is passed.
 *
 *   bun scripts/generate-demo-previews.ts [--force]
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { env } from "@/config/env";
import { PreviewRenderer } from "@/modules/previews/previews.ffmpeg";
import {
  demoPreviewPath,
  previewRenderSettings,
} from "@/modules/previews/previews.settings";

type Row = {
  file_path: string;
  duration_seconds: number | null;
  audio_codec: string | null;
};

const force = process.argv.includes("--force");
const sources = new Map<string, Row>();
// The live database may hold runtime additions; the baseline is what resets restore.
for (const path of [env.DEMO_DATABASE_PATH, `${env.DEMO_DATABASE_PATH}.baseline`]) {
  if (!existsSync(path)) continue;
  const database = new Database(path, { readonly: true });
  for (const row of database
    .query<Row, []>(
      "SELECT file_path, max(duration_seconds) AS duration_seconds, max(audio_codec) AS audio_codec FROM demo_videos GROUP BY file_path"
    )
    .all())
    if (!sources.has(row.file_path)) sources.set(row.file_path, row);
  database.close();
}

const renderer = new PreviewRenderer({
  ffmpegPath: env.FFMPEG_PATH,
  ffprobePath: env.FFPROBE_PATH,
  vaapiDevice: env.VAAPI_DEVICE,
});

let rendered = 0;
let skipped = 0;
let failed = 0;
let bytes = 0;
const started = Date.now();
for (const row of sources.values()) {
  const input = resolve(row.file_path);
  const output = resolve(demoPreviewPath(row.file_path));
  if (!existsSync(input) || !row.duration_seconds) {
    console.warn(`skip (missing source or duration): ${row.file_path}`);
    skipped++;
    continue;
  }
  if (existsSync(output)) {
    if (!force) {
      skipped++;
      continue;
    }
    await unlink(output);
  }
  await mkdir(dirname(output), { recursive: true });
  try {
    const result = await renderer.render(
      {
        inputPath: input,
        outputPath: output,
        durationSeconds: row.duration_seconds,
        hasAudio: Boolean(row.audio_codec),
        ...previewRenderSettings(),
      },
      "background"
    );
    rendered++;
    bytes += result.sizeBytes;
    console.log(
      `ok ${(result.sizeBytes / 1024).toFixed(0)}KB ${result.clipCount} clips ${result.width}x${result.height} ${row.file_path}`
    );
  } catch (error) {
    failed++;
    console.error(`failed ${row.file_path}: ${(error as Error).message}`);
  }
}

console.log(
  `\n${rendered} rendered (${(bytes / 1024 / 1024).toFixed(1)} MB), ${skipped} skipped, ${failed} failed in ${((Date.now() - started) / 1000).toFixed(0)}s`
);
process.exit(failed ? 1 : 0);
