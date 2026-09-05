import { afterAll, beforeAll, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { probeRenderedEditOutput } from "@/modules/edits/edits.render-validation";
import { hasUnexpectedEditVideoGap } from "@/modules/edits/edits.packet-validation";

let directory: string;
let source: string;
let frozen: string;
let offsetSource: string;
let offsetFrozen: string;
const timeline = { segments: [{ start: 0, end: 12 }] };

function ffmpeg(args: string[]) {
  const result = spawnSync("ffmpeg", ["-v", "error", "-nostdin", ...args], {
    encoding: "utf8",
    timeout: 15_000,
  });
  if (result.status !== 0) throw new Error(result.stderr || "Fixture failed");
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "edit-continuity-"));
  source = join(directory, "source.mkv");
  frozen = join(directory, "frozen.mkv");
  offsetSource = join(directory, "offset-source.mkv");
  offsetFrozen = join(directory, "offset-frozen.mkv");
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=160x90:rate=10:duration=12",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=12",
    "-c:v",
    "ffv1",
    "-c:a",
    "pcm_s16le",
    source,
  ]);
  ffmpeg([
    "-i",
    source,
    "-vf",
    "select='lt(t,2)+gte(t,10)'",
    "-fps_mode",
    "passthrough",
    "-c:v",
    "ffv1",
    "-c:a",
    "copy",
    frozen,
  ]);
  for (const [input, output] of [
    [source, offsetSource],
    [frozen, offsetFrozen],
  ]) {
    ffmpeg(["-i", input!, "-c", "copy", "-output_ts_offset", "100", output!]);
  }
});

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

it("rejects the frozen-middle edit that passes duration and audio validation", async () => {
  // The old acceptance check passes: both streams still end at 12 seconds.
  const accepted = await probeRenderedEditOutput(frozen, 12, true);
  expect(accepted.videoDuration).toBe(12);
  expect(accepted.audioDuration).toBeCloseTo(12, 2);
  await expect(
    probeRenderedEditOutput(frozen, 12, true, undefined, {
      path: source,
      timeline,
    })
  ).rejects.toMatchObject({ reason: "video_frame_gap" });
});

it("accepts continuous video without changing its timing", async () => {
  await expect(
    probeRenderedEditOutput(source, 12, true, undefined, {
      path: source,
      timeline,
    })
  ).resolves.toMatchObject({ videoDuration: 12 });
});

it("allows a pause already present in the selected source", async () => {
  await expect(
    probeRenderedEditOutput(frozen, 12, true, undefined, {
      path: frozen,
      timeline,
    })
  ).resolves.toMatchObject({ videoDuration: 12 });
});

it("detects missing frames when the source has a nonzero timestamp origin", async () => {
  await expect(
    hasUnexpectedEditVideoGap(frozen, offsetSource, timeline)
  ).resolves.toBe(true);
});

it("allows an existing pause when source and output timestamp origins differ", async () => {
  await expect(
    hasUnexpectedEditVideoGap(frozen, offsetFrozen, timeline)
  ).resolves.toBe(false);
  await expect(
    hasUnexpectedEditVideoGap(offsetFrozen, frozen, timeline)
  ).resolves.toBe(false);
});
