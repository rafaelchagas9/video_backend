import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PreviewRenderer,
  planPreviewClips,
  type PreviewRenderOptions,
} from "@/modules/previews/previews.ffmpeg";

const plan = { clipCount: 10, clipSeconds: 2.5, maxCoverage: 0.3 };

describe("planPreviewClips", () => {
  it("uses every clip for long videos, spread from 5% to 90%", () => {
    const { starts, clipSeconds } = planPreviewClips(1000, plan);
    expect(starts).toHaveLength(10);
    expect(clipSeconds).toBe(2.5);
    expect(starts[0]).toBeCloseTo(50);
    expect(starts[9]).toBeCloseTo(900);
    for (let i = 1; i < starts.length; i++)
      expect(starts[i]!).toBeGreaterThan(starts[i - 1]!);
  });

  it("caps coverage so short videos get fewer clips", () => {
    // 82s * 0.3 / 2.5 = 9.84 -> 9 clips
    expect(planPreviewClips(82, plan).starts).toHaveLength(9);
    expect(planPreviewClips(30, plan).starts).toHaveLength(3);
  });

  it("keeps one clip inside the runtime for very short videos", () => {
    const { starts, clipSeconds } = planPreviewClips(2, plan);
    expect(starts).toHaveLength(1);
    expect(clipSeconds).toBeCloseTo(1.8);
    expect(starts[0]! + clipSeconds).toBeLessThanOrEqual(2);
  });

  it("rejects unusable durations", () => {
    expect(() => planPreviewClips(0, plan)).toThrow();
    expect(() => planPreviewClips(Number.NaN, plan)).toThrow();
  });
});

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "preview-render-test-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function fixture(name: string, withAudio: boolean, size = "320x180") {
  const path = join(root, `${name}.mp4`);
  const process = Bun.spawn(
    [
      "ffmpeg",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `testsrc2=s=${size}:r=25`,
      ...(withAudio ? ["-f", "lavfi", "-i", "sine=f=440:r=48000"] : []),
      "-t",
      "40",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      ...(withAudio ? ["-c:a", "aac"] : []),
      path,
    ],
    { stdout: "ignore", stderr: "pipe" }
  );
  const stderr = await new Response(process.stderr).text();
  if ((await process.exited) !== 0) throw new Error(stderr);
  return path;
}

function options(
  inputPath: string,
  outputPath: string,
  hasAudio: boolean
): PreviewRenderOptions {
  return {
    inputPath,
    outputPath,
    durationSeconds: 40,
    hasAudio,
    plan: { clipCount: 4, clipSeconds: 1, maxCoverage: 0.3 },
    height: 144,
    crf: 45,
    preset: 12,
    audioBitrateKbps: 64,
  };
}

async function probe(path: string) {
  const process = Bun.spawn(
    [
      "ffprobe",
      "-v",
      "error",
      "-show_entries",
      "stream=codec_type,codec_name,width,height",
      "-of",
      "json",
      path,
    ],
    { stdout: "pipe" }
  );
  const output = await new Response(process.stdout).text();
  await process.exited;
  return (
    JSON.parse(output) as {
      streams: {
        codec_type: string;
        codec_name: string;
        width?: number;
        height?: number;
      }[];
    }
  ).streams;
}

const renderer = new PreviewRenderer({
  ffmpegPath: "ffmpeg",
  ffprobePath: "ffprobe",
});

it("stitches an AV1 + AAC teaser scaled to the target short side", async () => {
  const input = await fixture("with-audio", true);
  const output = join(root, "with-audio.preview.mp4");
  const result = await renderer.render(
    options(input, output, true),
    "interactive"
  );
  expect(result.clipCount).toBe(4);
  expect(result.hasAudio).toBe(true);
  expect(result.durationSeconds).toBeGreaterThan(3.5);
  expect(result.durationSeconds).toBeLessThan(4.5);
  expect([result.width, result.height]).toEqual([256, 144]);
  const streams = await probe(output);
  expect(streams.find((s) => s.codec_type === "video")?.codec_name).toBe("av1");
  expect(streams.find((s) => s.codec_type === "audio")?.codec_name).toBe("aac");
  expect(result.sizeBytes).toBe((await stat(output)).size);
});

it("fits vertical sources on their short side", async () => {
  const input = await fixture("vertical", false, "180x320");
  const output = join(root, "vertical.preview.mp4");
  const result = await renderer.render(
    options(input, output, false),
    "background"
  );
  expect([result.width, result.height]).toEqual([144, 256]);
});

it("falls back to video-only when claimed audio is missing", async () => {
  const input = await fixture("silent", false);
  const output = join(root, "silent.preview.mp4");
  const result = await renderer.render(
    options(input, output, true),
    "interactive"
  );
  expect(result.hasAudio).toBe(false);
  expect((await probe(output)).some((s) => s.codec_type === "audio")).toBe(
    false
  );
});

it("never overwrites an existing file and leaves no temporaries", async () => {
  const input = await fixture("existing", false);
  const output = join(root, "existing.preview.mp4");
  await writeFile(output, "keep");
  await expect(
    renderer.render(options(input, output, false), "interactive")
  ).rejects.toThrow();
  expect(await Bun.file(output).text()).toBe("keep");
  const leftovers = (await readdir(root)).filter((name) =>
    name.startsWith("existing.preview.mp4.")
  );
  expect(leftovers).toEqual([]);
});
