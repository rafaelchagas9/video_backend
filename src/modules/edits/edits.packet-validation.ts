import { spawn } from "node:child_process";
import { env } from "@/config/env";
import type { EditTimelineConfig } from "./edits.types";

export interface TimeInterval {
  start: number;
  end: number;
}
const GAP_SECONDS = 1;
const EDGE_TOLERANCE_SECONDS = 0.25;

/** Merge presentation timestamps, including reordered and duplicate packets. */
export class VideoPacketCoverage {
  private readonly ranges: TimeInterval[] = [];
  packetCount = 0;

  add(timestamp: number): void {
    if (!Number.isFinite(timestamp)) return;
    this.packetCount++;
    let low = 0;
    let high = this.ranges.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.ranges[middle]!.start <= timestamp) low = middle + 1;
      else high = middle;
    }
    const previous = this.ranges[low - 1];
    const next = this.ranges[low];
    if (previous && timestamp <= previous.end + GAP_SECONDS) {
      previous.end = Math.max(previous.end, timestamp);
      if (next && next.start - previous.end <= GAP_SECONDS) {
        previous.end = Math.max(previous.end, next.end);
        this.ranges.splice(low, 1);
      }
    } else if (next && next.start - timestamp <= GAP_SECONDS) {
      next.start = timestamp;
    } else {
      this.ranges.splice(low, 0, { start: timestamp, end: timestamp });
    }
  }

  gaps(duration: number, origin = 0): TimeInterval[] {
    const gaps: TimeInterval[] = [];
    let end = origin;
    for (const range of this.ranges) {
      if (range.start - end > GAP_SECONDS)
        gaps.push({ start: end - origin, end: range.start - origin });
      end = Math.max(end, range.end);
    }
    if (origin + duration - end > GAP_SECONDS)
      gaps.push({ start: end - origin, end: duration });
    return gaps;
  }
}

/**
 * Translate output holes through cuts, reordered selections, and speed changes.
 * `leads` are how far past each segment's start its first decodable frame sits:
 * a seek into a stream whose intra frames are not IDR starts at a later one.
 */
export function mapEditGapsToSourceIntervals(
  gaps: TimeInterval[],
  timeline: EditTimelineConfig,
  leads: readonly number[] = []
): TimeInterval[] {
  const intervals: TimeInterval[] = [];
  let offset = 0;
  timeline.segments.forEach((segment, index) => {
    const speed = segment.speed ?? 1;
    const start = segment.start + (leads[index] ?? 0);
    const end = offset + (segment.end - segment.start) / speed;
    for (const gap of gaps) {
      // Ignore frame rounding and seek alignment at both edges of a hole.
      const from = Math.max(offset, gap.start + EDGE_TOLERANCE_SECONDS);
      const to = Math.min(end, gap.end - EDGE_TOLERANCE_SECONDS);
      if (to > from)
        intervals.push({
          start: start + (from - offset) * speed,
          end: start + (to - offset) * speed,
        });
    }
    offset = end;
  });
  intervals.sort((a, b) => a.start - b.start);
  const merged: TimeInterval[] = [];
  for (const interval of intervals) {
    const previous = merged.at(-1);
    if (previous && interval.start <= previous.end)
      previous.end = Math.max(previous.end, interval.end);
    else merged.push({ ...interval });
  }
  return merged;
}

function inspectTimestamps(
  path: string,
  onTimestamp: ((timestamp: number) => void) | undefined,
  signal?: AbortSignal,
  intervals?: TimeInterval[]
): Promise<number> {
  if (signal?.aborted)
    return Promise.reject(new Error("Packet inspection cancelled"));
  const args = ["-v", "error", "-select_streams", "v:0"];
  if (intervals && intervals.length <= 100) {
    args.push(
      "-read_intervals",
      intervals
        .map(({ start, end }) => `${start.toFixed(6)}%${end.toFixed(6)}`)
        .join(",")
    );
  }
  args.push(
    "-show_entries",
    onTimestamp ? "packet=pts_time:format=start_time" : "format=start_time",
    "-of",
    "compact=p=0:nk=0",
    path
  );
  return new Promise((resolve, reject) => {
    const child = spawn(env.FFPROBE_PATH, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let pending = "";
    let origin = 0;
    let failure: Error | undefined;
    const stop = (message: string) => {
      failure ??= new Error(message);
      if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
    };
    const abort = () => stop("Packet inspection cancelled");
    const timeout = setTimeout(
      () => stop("Packet inspection timed out"),
      120_000
    );
    timeout.unref();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const consume = (line: string) => {
      const match = /^(pts_time|start_time)=([^|\r]+)/.exec(line);
      if (!match) return;
      const timestamp = Number(match[2]);
      if (!Number.isFinite(timestamp)) return;
      if (match[1] === "start_time") origin = timestamp;
      else onTimestamp?.(timestamp);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (failure) return;
      pending += chunk.toString();
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) consume(line);
      if (pending.length > 65_536) stop("Invalid packet inspection output");
    });
    // Drain errors, but never expose private input paths in job messages.
    child.stderr.resume();
    child.on("error", () => {
      failure ??= new Error("Packet inspection could not start");
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      if (failure || code !== 0)
        reject(failure ?? new Error("Packet inspection failed"));
      else {
        consume(pending);
        resolve(origin);
      }
    });
  });
}

const SEEK_PROBE_SECONDS = 10;

/** The native timestamp of the first frame FFmpeg decodes after `-ss start`, as the edit render seeks. */
function firstDecodedTimestamp(
  path: string,
  start: number,
  signal?: AbortSignal
): Promise<number | null> {
  if (signal?.aborted)
    return Promise.reject(new Error("Packet inspection cancelled"));
  const args = [
    "-hide_banner",
    "-nostats",
    "-ss",
    start.toFixed(6),
    "-t",
    String(SEEK_PROBE_SECONDS),
    "-an",
    "-copyts",
    "-i",
    path,
    "-frames:v",
    "1",
    "-vf",
    "showinfo",
    "-f",
    "null",
    "-",
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(env.FFMPEG_PATH, args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    let failure: Error | undefined;
    const stop = (message: string) => {
      failure ??= new Error(message);
      if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
    };
    const abort = () => stop("Packet inspection cancelled");
    const timeout = setTimeout(() => stop("Seek inspection timed out"), 60_000);
    timeout.unref();
    signal?.addEventListener("abort", abort, { once: true });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 65_536) stderr += chunk.toString();
    });
    child.on("error", () => {
      failure ??= new Error("Seek inspection could not start");
    });
    child.on("close", () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      if (failure) return reject(failure);
      const match = /pts_time:(-?[\d.]+)/.exec(stderr);
      const timestamp = match ? Number(match[1]) : Number.NaN;
      resolve(Number.isFinite(timestamp) ? timestamp : null);
    });
  });
}

/** Check packet timing without decoding images; consult the source only for holes. */
export async function hasUnexpectedEditVideoGap(
  outputPath: string,
  sourcePath: string,
  timeline: EditTimelineConfig,
  signal?: AbortSignal,
  options: { seeked?: boolean } = {}
): Promise<boolean> {
  const coverage = new VideoPacketCoverage();
  const outputOrigin = await inspectTimestamps(
    outputPath,
    (timestamp) => coverage.add(timestamp),
    signal
  );
  if (!coverage.packetCount)
    throw new Error("Rendered video has no timed packets");
  const duration = timeline.segments.reduce(
    (sum, segment) =>
      sum + (segment.end - segment.start) / (segment.speed ?? 1),
    0
  );
  const outputGaps = coverage.gaps(duration, outputOrigin);
  if (!outputGaps.length) return false;
  let relativeIntervals = mapEditGapsToSourceIntervals(outputGaps, timeline);
  if (!relativeIntervals.length) return false;
  // Edit seeks are playback-relative, but ffprobe exposes native timestamps.
  // Match FFmpeg's default -ss origin before seeking or comparing source packets.
  const sourceOrigin = await inspectTimestamps(sourcePath, undefined, signal);
  if (options.seeked) {
    // Each segment's frames start where its seek really landed, often a second or
    // more late in live recordings; mapping from the nominal start would shift the
    // source's own dropouts onto frames that exist and report them as lost.
    const leads: number[] = [];
    for (const segment of timeline.segments) {
      const first = await firstDecodedTimestamp(sourcePath, segment.start, signal);
      const lead = first === null ? 0 : first - sourceOrigin - segment.start;
      leads.push(Math.min(SEEK_PROBE_SECONDS, Math.max(0, lead)));
    }
    relativeIntervals = mapEditGapsToSourceIntervals(outputGaps, timeline, leads);
    if (!relativeIntervals.length) return false;
  }
  const intervals = relativeIntervals.map(({ start, end }) => ({
    start: start + sourceOrigin,
    end: end + sourceOrigin,
  }));
  const seen = intervals.map(() => new Set<number>());
  let missing = false;
  await inspectTimestamps(
    sourcePath,
    (timestamp) => {
      let low = 0;
      let high = intervals.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (intervals[middle]!.start <= timestamp) low = middle + 1;
        else high = middle;
      }
      const index = low - 1;
      if (index < 0 || timestamp > intervals[index]!.end) return;
      const packets = seen[index]!;
      if (packets.size < 3) packets.add(timestamp);
      // Require multiple distinct source frames, avoiding isolated boundary rounding.
      if (packets.size >= 3) missing = true;
    },
    signal,
    intervals
  );
  return missing;
}
