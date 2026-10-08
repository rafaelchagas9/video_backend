/**
 * How much reviewing a recording teaches the highlight model, so the review queue can put the
 * most useful recordings first. Free of I/O so it can be tested.
 *
 * The model learns from kept-versus-skipped pairs inside one recording, and from variety across
 * channels (see recordings.autopilot.policy), so a recording is worth most when:
 * - its proposed highlights already disagree (some start kept, some start skipped as likely
 *   skips), which is the mixed signal itself once confirmed;
 * - it has at least two highlights, so one can be kept and another skipped;
 * - its channel has not yet given enough such recordings. Several waiting recordings from one
 *   channel each count towards that channel, so the top of the queue spreads across channels.
 */
import { createHash } from "node:crypto";

export interface TrainingCandidate {
  videoId: number;
  status: string;
  /** Proposed highlights with their current keep flag; null before analysis. */
  clips: { keep: boolean }[] | null;
  /** GoondVR channel from the file name, lower-cased; null when the name does not say. */
  channel: string | null;
}

/** 0–1: how likely the recording yields a kept and a skipped highlight, from its highlights alone. */
export function mixedSignal(clips: { keep: boolean }[] | null): number {
  if (!clips) return 0.35; // Not analysed: unknown, but most recordings end up with highlights.
  const kept = clips.filter((clip) => clip.keep).length;
  const skipped = clips.length - kept;
  // A few more highlights add labels; a long list mostly adds review time.
  const extra = 0.03 * (Math.min(clips.length, 5) - 2) - 0.02 * Math.max(0, clips.length - 8);
  if (kept && skipped) return Math.max(0.8, 0.9 + extra);
  if (clips.length >= 2) return Math.max(0.45, 0.55 + extra);
  return clips.length === 1 ? 0.15 : 0;
}

/** 0.4–1: how much a channel still needs, given its recordings with a kept and a skipped clip. */
export function channelNeed(paired: number, enough: number, known: boolean): number {
  if (!known) return 0.7;
  if (enough <= 0) return 1;
  return 0.4 + 0.6 * Math.max(0, enough - paired) / enough;
}

/**
 * Training value 0–100 for each candidate, by video id. `paired` holds each channel's reviewed
 * recordings with a kept and a skipped clip; `enough` is where a channel stops adding much.
 */
export function trainingValues(candidates: TrainingCandidate[], paired: Map<string, number>, enough: number): Map<number, number> {
  const signals = candidates
    .map((candidate) => ({ candidate, signal: mixedSignal(candidate.clips) }))
    .sort((a, b) => b.signal - a.signal || a.candidate.videoId - b.candidate.videoId);
  // Walk the likeliest pairs first, counting each towards its channel, so the second and third
  // recording of one channel rank below the first of another.
  const expected = new Map(paired);
  const values = new Map<number, number>();
  for (const { candidate, signal } of signals) {
    const { channel } = candidate;
    const soFar = channel ? (expected.get(channel) ?? 0) : 0;
    values.set(candidate.videoId, Math.round(signal * channelNeed(soFar, enough, channel !== null) * 100));
    if (channel) expected.set(channel, soFar + signal);
  }
  return values;
}

/** About one recording in ten, picked at random but stably by id, for the audit slice. */
export const AUDIT_SHARE = 0.1;

/**
 * Whether the recording is in the audit slice: placed in the queue regardless of training value,
 * so its decisions show what the value-ranked queue would otherwise bias. No position weights.
 */
export function isAuditRecording(videoId: number): boolean {
  const digest = createHash("sha256").update(`kura-review-audit-v1:${videoId}`).digest();
  return digest.readUInt32BE(0) / 0x1_0000_0000 < AUDIT_SHARE;
}
