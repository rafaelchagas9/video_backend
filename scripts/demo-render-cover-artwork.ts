/**
 * Cuts demo artwork from the covers in `demo_mode/scene-credits.json` with the
 * real artwork pipeline, so demo mode shows what accepting a cover does to a
 * card, poster or hero. Only variants the cover serves are rendered (frame
 * variants keep their existing demo art — rendering them would read face
 * detections from the personal database by demo video id).
 *
 * Output: `demo_mode/artwork/cover-<id>/…` and `demo_mode/scene-credits-artwork.json`.
 *   bun scripts/demo-render-cover-artwork.ts
 */

import { mkdir, rename, rm, writeFile } from "fs/promises";
import { join, relative, resolve } from "path";
import sharp from "sharp";

const DEMO_ROOT = resolve(process.cwd(), process.env.DEMO_ASSETS_DIR || "./demo_mode");
const STAGING = join(DEMO_ROOT, ".cover-artwork-staging");
// The pipeline writes under ARTWORK_DIR/video-<id>; point it at a staging dir.
process.env.ARTWORK_DIR = STAGING;

const { generateArtworkFiles, coverServesVariant } = await import("../src/modules/artwork/artwork.processing");
const { RASTER_ARTWORK_VARIANTS } = await import("../src/modules/artwork/artwork.types");
const fixture = (await Bun.file(join(DEMO_ROOT, "scene-credits.json")).json()) as {
  scenes: Array<{ video_id: number; title?: string; cover?: string }>;
};
const { Database } = await import("bun:sqlite");
const demo = new Database(join(DEMO_ROOT, "demo.sqlite.baseline"), { readonly: true });

const output: Record<string, { palette: unknown; assets: unknown[] }> = {};
await rm(STAGING, { recursive: true, force: true });

for (const scene of fixture.scenes) {
  if (!scene.cover) continue;
  const video = demo
    .query<{ id: number; file_path: string; file_name: string; title: string | null; duration_seconds: number | null; width: number | null; height: number | null }, [number]>(
      "SELECT id, file_path, file_name, title, duration_seconds, width, height FROM demo_videos WHERE id=?"
    )
    .get(scene.video_id);
  if (!video) continue;
  const coverPath = resolve(process.cwd(), scene.cover);
  const meta = await sharp(coverPath).metadata();
  const cover = { path: coverPath, width: meta.width!, height: meta.height! };
  const frame = video.width && video.height ? { width: video.width, height: video.height } : null;
  const variants = RASTER_ARTWORK_VARIANTS.filter((variant) => coverServesVariant(variant, cover, frame));
  if (variants.length === 0) continue;

  const generated = await generateArtworkFiles({
    video: { ...video, title: scene.title ?? video.title },
    request: { variants, force: true },
    cover,
  });
  const directory = join(DEMO_ROOT, "artwork", `cover-${String(video.id).padStart(3, "0")}`);
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const assets = [];
  for (const asset of generated.assets) {
    const target = join(directory, asset.filePath.split("/").pop()!);
    await rename(asset.filePath, target);
    assets.push({
      variant: asset.variant,
      content_hash: asset.contentHash,
      file_path: relative(process.cwd(), target),
      file_size_bytes: asset.fileSizeBytes,
      width: asset.width,
      height: asset.height,
      source_timestamp_seconds: asset.sourceTimestampSeconds,
      crop: asset.crop,
      focal_point: asset.focalPoint,
      safe_area: asset.safeArea,
      bottom_luma: asset.bottomLuma,
      effects: asset.effects,
    });
  }
  const current = demo
    .query<{ palette_json: string | null }, [number]>("SELECT palette_json FROM demo_artwork WHERE video_id=?")
    .get(video.id);
  output[String(video.id)] = {
    palette: generated.palette ?? (current?.palette_json ? JSON.parse(current.palette_json) : null),
    assets,
  };
  console.log(`video ${video.id}: ${variants.join(", ")} from cover ${cover.width}×${cover.height}`);
}

await rm(STAGING, { recursive: true, force: true });
await writeFile(join(DEMO_ROOT, "scene-credits-artwork.json"), `${JSON.stringify(output, null, 2)}\n`);
