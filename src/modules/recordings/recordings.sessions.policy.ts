/**
 * Live sessions, free of I/O so they can be tested: what Kura does with a channel's lives
 * (capture modes), when a live counts as over, what a minute's sample adds to it, which recording
 * files belong to it, and how its kept moments become one timeline.
 */
import type { LiveSessionClip, LiveSessionTitle } from "@/database/schema";

/**
 * manual: Kura leaves the channel alone. whole: always recorded, files kept as they are.
 * highlights: always recorded; once the live ends, the moments the model is at least
 * `threshold` sure about become one video and the raw files are deleted.
 * training: the data-gathering autopilot (records on live-frame action, retires channels).
 */
export const CAPTURE_MODES = ["manual", "whole", "highlights", "training"] as const;
export type CaptureMode = (typeof CAPTURE_MODES)[number];

export const isCaptureMode = (value: unknown): value is CaptureMode => (CAPTURE_MODES as readonly unknown[]).includes(value);

/** A stream that drops for less than this is the same live (GoondVR reconnects in seconds). */
export const LIVE_END_GRACE_MINUTES = 10;
/** Files that started this long before Kura first saw the channel online still belong to the live. */
const FILE_LEAD_MINUTES = 5;

export const SESSION_STATUSES = ["live", "kept", "waiting", "rendering", "done", "empty", "failed"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export interface SessionSampleInput {
  startedAt: Date;
  titles: LiveSessionTitle[];
  viewers: [number, number][];
  peakViewers: number;
}

export interface ChannelSample {
  viewers: number;
  title: string;
  now: Date;
}

/** What one minute online adds: a viewer reading, and the title when it changed. */
export function sampleSession(session: SessionSampleInput, sample: ChannelSample) {
  const offset = Math.max(0, Math.round((sample.now.getTime() - session.startedAt.getTime()) / 1000));
  const viewers = sample.viewers > 0 ? [...session.viewers, [offset, sample.viewers] as [number, number]] : session.viewers;
  const title = sample.title.trim();
  const titles = title && session.titles.at(-1)?.title !== title ? [...session.titles, { at: sample.now.toISOString(), title }] : session.titles;
  return { viewers, titles, peakViewers: Math.max(session.peakViewers, sample.viewers), lastSeenAt: sample.now };
}

/** Whether an open live is over: offline, and not seen for the grace period. */
export function liveEnded(lastSeenAt: Date, online: boolean, now: Date): boolean {
  return !online && now.getTime() - lastSeenAt.getTime() >= LIVE_END_GRACE_MINUTES * 60_000;
}

/** The status a live gets when it ends: only highlights lives have work left. */
export function endedStatus(capture: string): SessionStatus {
  return capture === "highlights" ? "waiting" : "kept";
}

/** When GoondVR started a file, from its `<user>_YYYY-MM-DD_HH-MM-SS` name (UTC). */
export function recordedAtFromFileName(fileName: string): Date | null {
  const stamp = /_(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})/.exec(fileName);
  return stamp ? new Date(`${stamp[1]}T${stamp[2]}:${stamp[3]}:${stamp[4]}Z`) : null;
}

/** Whether a recording file belongs to a live: same channel, started inside it. */
export function fileInSession(
  fileName: string,
  session: { username: string; startedAt: Date; endedAt: Date | null; lastSeenAt: Date }
): boolean {
  const name = fileName.split("/").at(-1) ?? fileName;
  const user = /^(.+?)_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}/.exec(name)?.[1];
  if (!user || user.replace(/^@/, "").toLowerCase() !== session.username.replace(/^@/, "").toLowerCase()) return false;
  const at = recordedAtFromFileName(name);
  if (!at) return false;
  const end = session.endedAt ?? session.lastSeenAt;
  return at.getTime() >= session.startedAt.getTime() - FILE_LEAD_MINUTES * 60_000 && at.getTime() <= end.getTime() + 60_000;
}

/**
 * The highlights video's timeline: each recording's kept moments in recording order (touching
 * ones joined), recordings in the order they were made, each cut bounded by its file's length.
 */
export function sessionTimeline(
  recordings: { videoId: number; recordedAt: Date | null; durationSeconds: number; clips: { start_seconds: number; end_seconds: number }[] }[]
): { start: number; end: number; source_video_id: number }[] {
  const ordered = [...recordings].sort((a, b) => (a.recordedAt?.getTime() ?? 0) - (b.recordedAt?.getTime() ?? 0) || a.videoId - b.videoId);
  const segments: { start: number; end: number; source_video_id: number }[] = [];
  for (const recording of ordered) {
    const sorted = [...recording.clips].sort((a, b) => a.start_seconds - b.start_seconds);
    const joined: { start: number; end: number }[] = [];
    for (const clip of sorted) {
      const start = Math.max(0, clip.start_seconds);
      const end = Math.min(recording.durationSeconds, clip.end_seconds);
      if (end - start < 1) continue;
      const last = joined.at(-1);
      if (last && start <= last.end) last.end = Math.max(last.end, end);
      else joined.push({ start, end });
    }
    for (const stretch of joined) segments.push({ ...stretch, source_video_id: recording.videoId });
  }
  return segments;
}

export const keptSeconds = (clips: LiveSessionClip[]) => clips.reduce((sum, clip) => sum + Math.max(0, clip.end_seconds - clip.start_seconds), 0);

/** The room's tags: Chaturbate puts them in the title as hashtags. First use order, lower-cased. */
export function titleTags(titles: { title: string }[], limit = 20): string[] {
  const tags: string[] = [];
  for (const { title } of titles) {
    for (const match of title.matchAll(/#([\p{L}\p{N}_-]{2,40})/gu)) {
      const tag = match[1]!.toLowerCase();
      if (!tags.includes(tag)) tags.push(tag);
      if (tags.length >= limit) return tags;
    }
  }
  return tags;
}
