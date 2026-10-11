import { afterEach, expect, it, mock } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const calls: { executable: string; args: string[]; options: any }[] = [];
mock.module("@/config/env", () => ({
  env: { FFMPEG_PATH: "/fixture-ffmpeg", VAAPI_DEVICE: "/fixture-device" },
}));
mock.module("@/utils/logger", () => ({
  logger: { debug() {}, info() {}, warn() {}, error() {} },
}));
mock.module("@/utils/media-process", () => ({
  runMediaProcess: async (executable: string, args: string[], options: any) => {
    calls.push({ executable, args, options });
    const output = args.at(-1)!;
    await writeFile(output.replace("%04d", "0001"), "synthetic image fixture");
    return { stdout: "", stderr: "" };
  },
}));
const { FrameExtractionService } =
  await import("@/modules/frame-extraction/frame-extraction.service");
const directories: string[] = [];
afterEach(async () => {
  calls.length = 0;
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function temporary() {
  const directory = await mkdtemp(join(tmpdir(), "frame-process-fixture-"));
  directories.push(directory);
  return directory;
}

it("keeps seek, aspect padding, hardware decode and JPEG quality in single-frame commands", async () => {
  const directory = await temporary();
  const signal = new AbortController().signal;
  const output = await new FrameExtractionService(directory).extractFrame({
    videoPath: "/synthetic input; no shell.mkv",
    timestampSeconds: 12.5,
    outputDir: directory,
    targetWidth: 160,
    targetHeight: 90,
    quality: 90,
    signal,
  });
  const call = calls[0]!;
  expect(call.executable).toBe("/fixture-ffmpeg");
  expect(call.args).toEqual([
    "-nostdin",
    "-y",
    "-hwaccel",
    "vaapi",
    "-hwaccel_device",
    "/fixture-device",
    "-ss",
    "12.5",
    "-i",
    "/synthetic input; no shell.mkv",
    "-frames:v",
    "1",
    "-an",
    "-sn",
    "-dn",
    "-qscale:v",
    "5",
    "-vf",
    "scale=w=160:h=90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2",
    output,
  ]);
  expect(call.options.signal).toBe(signal);
});

it("retains keyframe selection, interval sampling and WebP sequence JPEG fallback", async () => {
  const directory = await temporary();
  const result = await new FrameExtractionService(directory).extractFrames({
    videoId: 1,
    videoPath: "/synthetic.mkv",
    videoDuration: 2,
    intervalSeconds: 2,
    outputFormat: "webp",
    keyframesOnly: true,
    targetWidth: 160,
  });
  const args = calls[0]!.args;
  expect(
    args.slice(args.indexOf("-skip_frame"), args.indexOf("-skip_frame") + 2)
  ).toEqual(["-skip_frame", "nokey"]);
  expect(args[args.indexOf("-vf") + 1]).toBe("fps=1/2,scale=160:-1");
  expect(args.at(-1)).toEndWith("frame_%04d.jpg");
  expect(result.frames).toHaveLength(1);
  expect(result.frames[0]!.timestampSeconds).toBe(0);
});

it("cancelled extraction does not create outputs or invoke an encoder", async () => {
  const directory = await temporary();
  const controller = new AbortController();
  controller.abort();
  await expect(
    new FrameExtractionService(directory).extractFrame({
      videoPath: "/synthetic.mkv",
      timestampSeconds: 0,
      outputDir: directory,
      signal: controller.signal,
    })
  ).rejects.toThrow();
  expect(calls).toHaveLength(0);
});
