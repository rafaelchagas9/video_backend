import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { env } from "@/config/env";
import type { RecordingClip } from "@/database/schema";
import { getProbeStreamDuration, parseProbeNumber, type EditProbeData } from "@/modules/edits/edits.render-validation";
import { BadRequestError } from "@/utils/errors";

const run = promisify(execFile);

/** Matroska's DURATION tag is the stream end timestamp; format.duration can include an audio-only tail. */
export function usableVideoDuration(probe: EditProbeData, catalogDuration: number): number {
  const video = probe.streams?.find((stream) => stream.codec_type === "video");
  if (!video) throw new BadRequestError("This recording has no video stream");
  const duration = getProbeStreamDuration(video);
  const directDuration = parseProbeNumber(video.duration);
  const videoEnd = duration === null ? null : duration + (directDuration === null ? 0 : Math.max(0, parseProbeNumber(video.start_time) ?? 0));
  const limits = [catalogDuration, parseProbeNumber(probe.format?.duration), videoEnd]
    .filter((value): value is number => value !== null && Number.isFinite(value) && value > 0);
  if (!limits.length) throw new BadRequestError("Could not inspect the recording's video duration");
  return Math.min(...limits);
}

export async function probeRecordingDuration(path: string, catalogDuration: number): Promise<number> {
  const { stdout } = await run(env.FFPROBE_PATH, [
    "-v", "error", "-show_entries",
    "format=duration:stream=codec_type,start_time,duration:stream_tags=DURATION",
    "-of", "json", path,
  ], { timeout: 30_000, maxBuffer: 1_000_000 });
  return usableVideoDuration(JSON.parse(stdout), catalogDuration);
}

/** Applies to saved reviews too, so retrying an old failed highlight uses the corrected end. */
export function capRecordingClips(clips: RecordingClip[], duration: number): RecordingClip[] {
  return clips.map((clip) => {
    if (clip.output_video_id || clip.job_id || clip.end_seconds <= duration) return clip;
    if (clip.keep && clip.start_seconds >= duration)
      throw new BadRequestError("A kept highlight starts after the recording's video ends. Adjust or skip it before rendering.");
    if (clip.start_seconds >= duration) return clip;
    return { ...clip, end_seconds: duration, peak_seconds: Math.min(clip.peak_seconds, duration) };
  });
}
