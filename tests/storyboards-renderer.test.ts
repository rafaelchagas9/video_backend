import { afterAll, beforeAll, expect, it } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import {
  StoryboardRenderer,
  keyframesCoverStoryboard,
  paginateSheet,
} from "@/modules/storyboards/storyboards.ffmpeg";

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "storyboard-render-test-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function fixture(name: string, duration: number, gop: number) {
  const path = join(root, `${name}.mp4`);
  const process = Bun.spawn(
    [
      "ffmpeg",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=red:s=128x72:r=25",
      "-t",
      String(duration),
      "-c:v",
      "libx264",
      "-g",
      String(gop),
      "-sc_threshold",
      "0",
      "-pix_fmt",
      "yuv420p",
      path,
    ],
    { stdout: "ignore", stderr: "pipe" }
  );
  const stderr = await new Response(process.stderr).text();
  if ((await process.exited) !== 0) throw new Error(stderr);
  return path;
}

it("fills the final partial tile and short videos using real FFmpeg", async () => {
  for (const duration of [0.2, 10.8]) {
    const inputPath = await fixture(`dense-${duration}`, duration, 50);
    const before = await stat(inputPath);
    const count = Math.ceil(duration / 5);
    const result = await new StoryboardRenderer({
      ffmpegPath: "ffmpeg",
    }).render({
      inputPath,
      outputPaths: [join(root, `dense-${duration}.p0.webp`)],
      durationSeconds: duration,
      tileWidth: 64,
      tileHeight: 36,
      intervalSeconds: 5,
      format: "webp",
      quality: 80,
    });
    expect(result.sampling).toBe("keyframes");
    const outputPath = join(root, `dense-${duration}.p0.webp`);
    const metadata = await sharp(outputPath).metadata();
    expect([metadata.width, metadata.height]).toEqual([64 * count, 36]);
    const last = await sharp(outputPath)
      .extract({ left: (count - 1) * 64, top: 0, width: 64, height: 36 })
      .stats();
    expect(last.channels[0]!.mean).toBeGreaterThan(150);
    const after = await stat(inputPath);
    expect([after.size, after.mtimeMs, after.ino]).toEqual([
      before.size,
      before.mtimeMs,
      before.ino,
    ]);
  }
});

it("splits long videos into 5×5 pages and trims the last page to its tiles", async () => {
  // 27 tiles: one full page, then a page holding two tiles in one row.
  const inputPath = await fixture("paged", 27 * 2 - 0.5, 25);
  const outputPaths = [0, 1].map((page) => join(root, `paged.p${page}.webp`));
  await new StoryboardRenderer({ ffmpegPath: "ffmpeg" }).render({
    inputPath,
    outputPaths,
    durationSeconds: 27 * 2 - 0.5,
    tileWidth: 64,
    tileHeight: 36,
    intervalSeconds: 2,
    format: "webp",
    quality: 80,
  });
  const sizes = await Promise.all(
    outputPaths.map(async (path) => {
      const { width, height } = await sharp(path).metadata();
      return [width, height];
    })
  );
  expect(sizes).toEqual([
    [320, 180],
    [128, 36],
  ]);
});

it("re-cuts a legacy sheet into pages without re-sampling the video", async () => {
  // A 7×4 legacy sheet holding 27 tiles, each a distinct grey level.
  const tiles = Array.from({ length: 27 }, (_, index) => index * 9);
  const sheetPath = join(root, "legacy.png");
  await sharp({
    create: { width: 7 * 64, height: 4 * 36, channels: 3, background: "#000" },
  })
    .composite(
      tiles.map((level, index) => ({
        input: {
          create: {
            width: 64,
            height: 36,
            channels: 3 as const,
            background: { r: level, g: level, b: level },
          },
        },
        left: (index % 7) * 64,
        top: Math.floor(index / 7) * 36,
      }))
    )
    .png()
    .toFile(sheetPath);
  const outputPaths = [0, 1].map((page) => join(root, `legacy.p${page}.jpg`));
  await paginateSheet({
    sheetPath,
    outputPaths,
    cols: 7,
    rows: 4,
    tileWidth: 64,
    tileHeight: 36,
    tileCount: 27,
    format: "jpg",
    quality: 95,
  });
  // Read the centre pixel of a tile (sharp's stats() ignores extract()).
  const level = async (path: string, index: number) => {
    const { data, info } = await sharp(path)
      .raw()
      .toBuffer({ resolveWithObject: true });
    const x = (index % 5) * 64 + 32;
    const y = Math.floor(index / 5) * 36 + 18;
    return data[(y * info.width + x) * info.channels]!;
  };
  expect(await level(outputPaths[0]!, 7)).toBeCloseTo(tiles[7]!, -1);
  expect(await level(outputPaths[0]!, 24)).toBeCloseTo(tiles[24]!, -1);
  expect(await level(outputPaths[1]!, 1)).toBeCloseTo(tiles[26]!, -1);
  const last = await sharp(outputPaths[1]!).metadata();
  expect([last.width, last.height]).toEqual([128, 36]);
});

it("falls back to precise sampling for sparse keyframes and recovers from unavailable VAAPI", async () => {
  const inputPath = await fixture("sparse", 10.8, 1_000);
  const result = await new StoryboardRenderer({
    ffmpegPath: "ffmpeg",
    vaapiDevice: "/synthetic/no-device",
  }).render({
    inputPath,
    outputPaths: [join(root, "sparse.p0.webp")],
    durationSeconds: 10.8,
    tileWidth: 64,
    tileHeight: 36,
    intervalSeconds: 5,
    format: "webp",
    quality: 80,
  });
  expect(result).toEqual({ sampling: "precise", hardware: false });
  expect(
    (await readdir(root)).filter((path) => /\.[a-f0-9-]{36}\./.test(path))
  ).toEqual([]);
});

it("bounds timing drift at the beginning, gaps, and the end", () => {
  expect(keyframesCoverStoryboard([0, 2, 4, 6, 8, 10], 10.8, 5, 5)).toBe(true);
  expect(keyframesCoverStoryboard([0, 8, 16], 20, 5, 5)).toBe(false);
  expect(keyframesCoverStoryboard([7], 10, 5, 3)).toBe(false);
  expect(keyframesCoverStoryboard([], 10, 5, 5)).toBe(false);
});
