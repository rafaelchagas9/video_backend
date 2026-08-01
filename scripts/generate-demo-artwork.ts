import { createHash } from "crypto";
import { mkdir, rm, stat, writeFile } from "fs/promises";
import { join, relative, resolve } from "path";
import sharp from "sharp";
import {
  calculateArtworkCrop,
  detectContentBox,
  extractArtworkPalette,
  renderArtworkTitle,
} from "../src/modules/artwork/artwork.processing";
import type {
  ArtworkEffect,
  ArtworkPalette,
  ArtworkVariant,
  NormalizedPoint,
  NormalizedRect,
} from "../src/modules/artwork/artwork.types";
import { commitStagedDemoArtwork } from "./demo-artwork-commit";

const DEMO_ROOT = resolve(
  process.cwd(),
  process.env.DEMO_ASSETS_DIR || "./demo_mode"
);
const OUTPUT_ROOT = join(DEMO_ROOT, "artwork");
const GENERATED_AT = "2026-07-31T00:00:00.000Z";
const FOCAL_POINT: NormalizedPoint = { x: 0.5, y: 0.42 };

const VARIANTS: Record<
  Exclude<ArtworkVariant, "title">,
  { width: number; height: number; effects: ArtworkEffect[] }
> = {
  card: { width: 640, height: 360, effects: [] },
  poster: { width: 400, height: 600, effects: ["scrim", "grain"] },
  square: { width: 400, height: 400, effects: ["scrim"] },
  hero: { width: 2560, height: 1097, effects: ["grain", "vignette"] },
};

interface DemoVideoSource {
  title: string;
  thumbnail?: {
    filePath: string;
    timestampSeconds: number;
  };
}

interface ManifestAsset {
  variant: ArtworkVariant;
  content_hash: string;
  file_path: string;
  file_size_bytes: number;
  width: number;
  height: number;
  source_timestamp_seconds: number | null;
  crop: NormalizedRect | null;
  focal_point: NormalizedPoint | null;
  safe_area: NormalizedRect | null;
  bottom_luma: number | null;
  thumbhash: string | null;
  effects: ArtworkEffect[];
}

interface ManifestEntry {
  title: string;
  palette: ArtworkPalette;
  assets: Partial<Record<ArtworkVariant, ManifestAsset>>;
}

function scrimSvg(width: number, height: number): Buffer {
  return Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="52%" stop-color="#000" stop-opacity="0"/><stop offset="78%" stop-color="#000" stop-opacity="0.18"/><stop offset="100%" stop-color="#000" stop-opacity="0.58"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>`
  );
}

function vignetteSvg(width: number, height: number): Buffer {
  return Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><defs><radialGradient id="v"><stop offset="68%" stop-color="#000" stop-opacity="0"/><stop offset="100%" stop-color="#000" stop-opacity="0.22"/></radialGradient></defs><rect width="100%" height="100%" fill="url(#v)"/></svg>`
  );
}

function grainLayer(width: number, height: number, seed: string) {
  let state = createHash("sha256").update(seed).digest().readUInt32LE(0);
  const rgba = Buffer.allocUnsafe(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const value = state & 0xff;
    const offset = index * 4;
    rgba[offset] = value;
    rgba[offset + 1] = value;
    rgba[offset + 2] = value;
    rgba[offset + 3] = 9;
  }
  return {
    input: rgba,
    raw: { width, height, channels: 4 as const },
    blend: "overlay" as const,
  };
}

function mapPointToCrop(
  point: NormalizedPoint,
  crop: NormalizedRect
): NormalizedPoint {
  return {
    x: Math.min(1, Math.max(0, (point.x - crop.x) / crop.width)),
    y: Math.min(1, Math.max(0, (point.y - crop.y) / crop.height)),
  };
}

async function bottomLuma(buffer: Buffer): Promise<number> {
  const { data, info } = await sharp(buffer)
    .resize(64, 36, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let sum = 0;
  let count = 0;
  for (let y = Math.floor(info.height * (2 / 3)); y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const offset = (y * info.width + x) * info.channels;
      const red = (data[offset] ?? 0) / 255;
      const green = (data[offset + 1] ?? 0) / 255;
      const blue = (data[offset + 2] ?? 0) / 255;
      sum += 0.2126 * red + 0.7152 * green + 0.0722 * blue;
      count += 1;
    }
  }
  return Number((sum / Math.max(1, count)).toFixed(5));
}

async function writeAsset(
  writeRoot: string,
  sourceKey: string,
  variant: ArtworkVariant,
  buffer: Buffer
): Promise<{ path: string; hash: string; size: number }> {
  const hash = createHash("sha256").update(buffer).digest("hex").slice(0, 16);
  const extension = variant === "title" ? "png" : "webp";
  const directory = join(writeRoot, sourceKey);
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${variant}-${hash}.${extension}`);
  await writeFile(path, buffer);
  return {
    path: relative(
      process.cwd(),
      join(OUTPUT_ROOT, sourceKey, `${variant}-${hash}.${extension}`)
    ),
    hash,
    size: (await stat(path)).size,
  };
}

async function renderRaster(
  writeRoot: string,
  sourcePath: string,
  sourceKey: string,
  variant: Exclude<ArtworkVariant, "title">,
  timestamp: number
): Promise<{ asset: ManifestAsset; buffer: Buffer }> {
  const spec = VARIANTS[variant];
  const metadata = await sharp(sourcePath).metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error(`Missing image dimensions for ${sourcePath}`);
  }
  // The demo catalogue is built from YouTube thumbnails, most of which are 4:3
  // frames with the 16:9 (or 2.39:1) image padded into them — so this pass
  // matters more here than it does on real extracted frames.
  const content = await detectContentBox(
    sourcePath,
    metadata.width,
    metadata.height
  );
  const contentRect: NormalizedRect = {
    x: content.left / metadata.width,
    y: content.top / metadata.height,
    width: content.width / metadata.width,
    height: content.height / metadata.height,
  };
  const crop = calculateArtworkCrop({
    sourceWidth: content.width,
    sourceHeight: content.height,
    targetWidth: spec.width,
    targetHeight: spec.height,
    focalPoint: mapPointToCrop(FOCAL_POINT, contentRect),
    poster: variant === "poster",
  });
  crop.pixels.left += content.left;
  crop.pixels.top += content.top;
  crop.normalized = {
    x: crop.pixels.left / metadata.width,
    y: crop.pixels.top / metadata.height,
    width: crop.pixels.width / metadata.width,
    height: crop.pixels.height / metadata.height,
  };
  const scale = Math.min(
    1,
    spec.width / crop.pixels.width,
    spec.height / crop.pixels.height
  );
  const width = Math.max(1, Math.round(crop.pixels.width * scale));
  const height = Math.max(1, Math.round(crop.pixels.height * scale));
  let pipeline = sharp(sourcePath)
    .rotate()
    .extract(crop.pixels)
    .resize(width, height, { fit: "fill", withoutEnlargement: true });
  const overlays = [];
  if (spec.effects.includes("scrim")) {
    overlays.push({ input: scrimSvg(width, height), blend: "over" as const });
  }
  if (spec.effects.includes("grain")) {
    overlays.push(grainLayer(width, height, `${sourceKey}:${variant}`));
  }
  if (spec.effects.includes("vignette")) {
    overlays.push({
      input: vignetteSvg(width, height),
      blend: "over" as const,
    });
  }
  if (overlays.length > 0) pipeline = pipeline.composite(overlays);
  const buffer = await pipeline
    .webp({ quality: 84, smartSubsample: true })
    .toBuffer();
  const stored = await writeAsset(writeRoot, sourceKey, variant, buffer);
  return {
    buffer,
    asset: {
      variant,
      content_hash: stored.hash,
      file_path: stored.path,
      file_size_bytes: stored.size,
      width,
      height,
      source_timestamp_seconds: timestamp,
      crop: crop.normalized,
      focal_point: mapPointToCrop(FOCAL_POINT, crop.normalized),
      safe_area:
        variant === "hero"
          ? { x: 0.04, y: 0.1, width: 0.42, height: 0.56 }
          : { x: 0.06, y: 0.08, width: 0.4, height: 0.5 },
      bottom_luma: await bottomLuma(buffer),
      thumbhash: null,
      effects: spec.effects,
    },
  };
}

async function main(): Promise<void> {
  process.env.DEMO_SQLITE_TOOL = "true";
  const {
    captureDemoArtworkDatabaseSnapshot,
    createDemoBaselineSnapshot,
    exportDemoSeedDocument,
    replaceDemoArtworkCatalog,
    restoreDemoArtworkDatabaseSnapshot,
  } = await import("@/database/demo");
  const catalog = exportDemoSeedDocument() as { videos: DemoVideoSource[] };
  const runId = `${process.pid}-${Date.now()}`;
  const stagingRoot = join(DEMO_ROOT, `.artwork-staging-${runId}`);
  const backupRoot = join(DEMO_ROOT, `.artwork-backup-${runId}`);
  await rm(stagingRoot, { recursive: true, force: true });
  await mkdir(stagingRoot, { recursive: true });

  try {
    const entries: Record<string, ManifestEntry> = {};
    for (const [index, video] of catalog.videos.entries()) {
      if (!video.thumbnail) continue;
      const sourcePath = resolve(process.cwd(), video.thumbnail.filePath);
      const sourceKey = String(index + 1).padStart(3, "0");
      const assets: Partial<Record<ArtworkVariant, ManifestAsset>> = {};
      let cardBuffer: Buffer | null = null;
      for (const variant of Object.keys(VARIANTS) as Array<
        Exclude<ArtworkVariant, "title">
      >) {
        const rendered = await renderRaster(
          stagingRoot,
          sourcePath,
          sourceKey,
          variant,
          video.thumbnail.timestampSeconds
        );
        assets[variant] = rendered.asset;
        if (variant === "card") cardBuffer = rendered.buffer;
      }

      const title = await renderArtworkTitle(video.title);
      if (title) {
        const stored = await writeAsset(
          stagingRoot,
          sourceKey,
          "title",
          title.buffer
        );
        assets.title = {
          variant: "title",
          content_hash: stored.hash,
          file_path: stored.path,
          file_size_bytes: stored.size,
          width: title.width,
          height: title.height,
          source_timestamp_seconds: null,
          crop: null,
          focal_point: null,
          safe_area: null,
          bottom_luma: null,
          thumbhash: null,
          effects: ["title"],
        };
      }

      if (!cardBuffer)
        throw new Error(`Card artwork was not generated for ${video.title}`);
      entries[video.thumbnail.filePath] = {
        title: video.title,
        palette: await extractArtworkPalette(cardBuffer),
        assets,
      };
      process.stdout.write(
        `Generated demo artwork ${index + 1}/${catalog.videos.length}\r`
      );
    }

    const baselinePath = await commitStagedDemoArtwork({
      outputRoot: OUTPUT_ROOT,
      stagingRoot,
      backupRoot,
      captureDatabaseSnapshot: captureDemoArtworkDatabaseSnapshot,
      replaceDatabase: () => replaceDemoArtworkCatalog(entries, GENERATED_AT),
      restoreDatabaseSnapshot: restoreDemoArtworkDatabaseSnapshot,
      createBaselineSnapshot: createDemoBaselineSnapshot,
    });
    process.stdout.write(
      `Generated ${Object.keys(entries).length} demo artwork sets and refreshed ${baselinePath}.\n`
    );
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

if (import.meta.main) await main();
