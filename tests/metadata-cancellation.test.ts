import { afterEach, beforeEach, expect, it, mock } from "bun:test";
import { spawn as nativeSpawn, type ChildProcess } from "node:child_process";

const spawnProcess = nativeSpawn;
const children: ChildProcess[] = [];
let probeCode: string;
const metadata = {
  streams: [
    {
      codec_type: "video",
      codec_name: "av1",
      width: 1920,
      height: 1080,
      r_frame_rate: "60000/1001",
      avg_frame_rate: "30/1",
    },
    { codec_type: "audio", codec_name: "opus" },
  ],
  format: { duration: "60.125", bit_rate: "5787000" },
};
mock.module("@/config/env", () => ({
  env: { FFMPEG_PATH: "/unused", FFPROBE_PATH: "/fake-probe" },
}));
mock.module("@/utils/logger", () => ({
  logger: { debug() {}, error() {} },
}));
mock.module("node:child_process", () => ({
  spawn: (_binary: string, _args: string[], options: object) => {
    const child = spawnProcess(process.execPath, ["-e", probeCode], options);
    children.push(child);
    return child;
  },
}));
const { MetadataService } = await import("@/modules/videos/metadata.service");

beforeEach(() => {
  children.length = 0;
  probeCode = `process.stdout.write(${JSON.stringify(JSON.stringify(metadata))});`;
});
afterEach(async () => {
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const closed = new Promise<void>((resolve) =>
      child.once("close", () => resolve())
    );
    child.kill("SIGKILL");
    await closed;
  }
});

function expectReaped(child: ChildProcess) {
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  expect(() => process.kill(child.pid!, 0)).toThrow();
}

it("preserves metadata fields and FPS selection for callers without a signal", async () => {
  await expect(
    new MetadataService().extractMetadata("/fixture.mkv")
  ).resolves.toEqual({
    duration_seconds: 60.125,
    width: 1920,
    height: 1080,
    codec: "av1",
    bitrate: 5787000,
    fps: 59.94,
    audio_codec: "opus",
  });
  expectReaped(children[0]!);
});

it("does not start a probe for an already cancelled request", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    new MetadataService().extractMetadata("/fixture.mkv", controller.signal)
  ).rejects.toThrow("cancelled");
  expect(children).toHaveLength(0);
});

it("kills and reaps a running metadata probe before cancellation settles", async () => {
  probeCode = "setInterval(() => {}, 1000);";
  const controller = new AbortController();
  const running = new MetadataService().extractMetadata(
    "/fixture.mkv",
    controller.signal
  );
  controller.abort();
  await expect(running).rejects.toThrow("cancelled");
  expectReaped(children[0]!);
});

it("kills and reaps a probe when its timeout expires", async () => {
  probeCode = "setInterval(() => {}, 1000);";
  await expect(
    new MetadataService(25).extractMetadata("/fixture.mkv")
  ).rejects.toThrow("timed out");
  expectReaped(children[0]!);
});

it("drains noisy stderr without exposing it or blocking successful metadata", async () => {
  probeCode = `process.stderr.write("x".repeat(200000)); ${probeCode}`;
  await expect(
    new MetadataService().extractMetadata("/fixture.mkv")
  ).resolves.toMatchObject({ codec: "av1" });
  expectReaped(children[0]!);
});
