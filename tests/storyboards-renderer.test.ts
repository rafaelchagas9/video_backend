import { afterAll, beforeAll, expect, it } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import {
  StoryboardRenderer,
  keyframesCoverStoryboard,
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
    const outputPath = join(root, `dense-${duration}.webp`);
    const result = await new StoryboardRenderer({
      ffmpegPath: "ffmpeg",
    }).render({
      inputPath,
      outputPath,
      durationSeconds: duration,
      tileWidth: 64,
      tileHeight: 36,
      intervalSeconds: 5,
      cols: count,
      rows: 1,
      format: "webp",
      quality: 80,
    });
    expect(result.sampling).toBe("keyframes");
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

it("falls back to precise sampling for sparse keyframes and recovers from unavailable VAAPI", async () => {
  const inputPath = await fixture("sparse", 10.8, 1_000);
  const result = await new StoryboardRenderer({
    ffmpegPath: "ffmpeg",
    vaapiDevice: "/synthetic/no-device",
  }).render({
    inputPath,
    outputPath: join(root, "sparse.webp"),
    durationSeconds: 10.8,
    tileWidth: 64,
    tileHeight: 36,
    intervalSeconds: 5,
    cols: 3,
    rows: 1,
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
