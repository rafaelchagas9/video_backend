/**
 * Highlight detection for long live recordings, from SigLIP frame embeddings.
 *
 * Two scorers feed one clipper:
 *
 * * **trained** (`detectWithProbe`) — a probe fitted on hand-labelled frames classifies every
 *   frame into a stream state; a frame's score is the probability of the states chosen as
 *   highlights. Absolute, so a recording with no highlight proposes nothing.
 * * **prompts** (`detectHighlights`) — a frame scores by how much more it looks like any
 *   highlight description than like the idle states that fill most of a stream, compared with
 *   the recording's own baseline (median / MAD), because lighting, camera and outfit shift
 *   every raw similarity.
 *
 * Stretches above the threshold become proposed clips.
 */
import { dot } from "@/modules/visual-search/visual-search.vectors";
import { classifyFrames, type HighlightProbe, type ProbeState } from "./recordings.probe";

export interface HighlightOptions {
  /** Robust z-score a frame must exceed to count as highlight material. */
  sensitivity: number;
  /** Matching frames closer than this join one clip. */
  mergeGapSeconds: number;
  /** Clips shorter than this (before padding) are noise. */
  minSeconds: number;
  /** Context kept before and after the matched stretch. */
  padSeconds: number;
  maxClips: number;
}

export const DEFAULT_HIGHLIGHT_OPTIONS: HighlightOptions = {
  sensitivity: 1.4,
  mergeGapSeconds: 35,
  minSeconds: 20,
  padSeconds: 10,
  maxClips: 24,
};

export interface ProposedClip {
  start_seconds: number;
  end_seconds: number;
  peak_seconds: number;
  score: number;
  label: string;
}

export interface HighlightResult {
  clips: ProposedClip[];
  /** Per-frame intensity in [0, 1], downsampled for drawing. */
  curve: number[];
}

function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function smooth(values: number[], radius: number): number[] {
  return values.map((_, index) => {
    let sum = 0;
    let count = 0;
    for (let offset = -radius; offset <= radius; offset++) {
      const value = values[index + offset];
      if (value === undefined) continue;
      sum += value;
      count++;
    }
    return count ? sum / count : 0;
  });
}

function downsample(values: number[], points: number): number[] {
  if (values.length <= points) return values;
  return Array.from({ length: points }, (_, point) => {
    const from = Math.floor((point * values.length) / points);
    const to = Math.max(from + 1, Math.floor(((point + 1) * values.length) / points));
    let best = 0;
    for (let index = from; index < to; index++) best = Math.max(best, values[index] ?? 0);
    return best;
  });
}

export function detectHighlights(input: {
  timestamps: number[];
  vectors: Float32Array[];
  durationSeconds: number;
  highlights: { label: string; vector: Float32Array }[];
  idle: Float32Array[];
  options?: Partial<HighlightOptions>;
}): HighlightResult {
  const options = { ...DEFAULT_HIGHLIGHT_OPTIONS, ...input.options };
  const { timestamps, vectors } = input;
  if (vectors.length < 4 || !input.highlights.length) return { clips: [], curve: [] };

  const best: number[] = [];
  const labels: string[] = [];
  for (const frame of vectors) {
    let top = -Infinity;
    let label = "";
    for (const highlight of input.highlights) {
      const value = dot(frame, highlight.vector);
      if (value > top) {
        top = value;
        label = highlight.label;
      }
    }
    const idle = input.idle.length
      ? input.idle.reduce((sum, vector) => sum + dot(frame, vector), 0) / input.idle.length
      : 0;
    best.push(top - idle);
    labels.push(label);
  }

  const center = median(best);
  const spread = 1.4826 * median(best.map((value) => Math.abs(value - center))) || 1e-6;
  const z = smooth(best.map((value) => (value - center) / spread), 1);
  const maxZ = Math.max(...z, options.sensitivity);
  const curve = downsample(z.map((value) => Math.max(0, value) / maxZ), 240).map(
    (value) => Math.round(value * 1000) / 1000
  );

  return { clips: shapeClips(timestamps, z, labels, options.sensitivity, input.durationSeconds, options), curve };
}

/** Runs of frames scoring at least `threshold`, joined across short gaps, padded, ranked. */
function shapeClips(
  timestamps: number[],
  scores: number[],
  labels: string[],
  threshold: number,
  durationSeconds: number,
  options: HighlightOptions
): ProposedClip[] {
  const interval = timestamps.length > 1 ? (timestamps.at(-1)! - timestamps[0]!) / (timestamps.length - 1) : 5;
  const runs: { from: number; to: number }[] = [];
  for (let index = 0; index < scores.length; index++) {
    if ((scores[index] ?? 0) < threshold) continue;
    const at = timestamps[index]!;
    const last = runs.at(-1);
    if (last && at - timestamps[last.to]! <= options.mergeGapSeconds) last.to = index;
    else runs.push({ from: index, to: index });
  }

  const clips: ProposedClip[] = [];
  for (const run of runs) {
    const start = timestamps[run.from]!;
    const end = timestamps[run.to]! + interval;
    if (end - start < options.minSeconds) continue;
    let peak = run.from;
    let sum = 0;
    const votes = new Map<string, number>();
    for (let index = run.from; index <= run.to; index++) {
      sum += scores[index] ?? 0;
      if ((scores[index] ?? 0) > (scores[peak] ?? 0)) peak = index;
      votes.set(labels[index]!, (votes.get(labels[index]!) ?? 0) + Math.max(0, scores[index] ?? 0));
    }
    const label = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
    clips.push({
      start_seconds: Math.max(0, Math.round(start - options.padSeconds)),
      end_seconds: Math.min(durationSeconds || Infinity, Math.round(end + options.padSeconds)),
      peak_seconds: Math.round(timestamps[peak]!),
      score: Math.round((sum / (run.to - run.from + 1)) * 100) / 100,
      label,
    });
  }

  // Padding can make neighbours overlap; overlapping clips are one clip.
  const merged: ProposedClip[] = [];
  for (const clip of clips) {
    const last = merged.at(-1);
    if (last && clip.start_seconds <= last.end_seconds) {
      last.end_seconds = Math.max(last.end_seconds, clip.end_seconds);
      if (clip.score > last.score) {
        last.score = clip.score;
        last.peak_seconds = clip.peak_seconds;
        last.label = clip.label;
      }
    } else merged.push({ ...clip });
  }
  const kept = merged
    .sort((a, b) => b.score - a.score)
    .slice(0, options.maxClips)
    .sort((a, b) => a.start_seconds - b.start_seconds);
  return kept;
}

/**
 * Short, weak highlights from the trained detector start out skipped. In the first 140
 * reviewed (2026-10-07), ones under 3 minutes and below 0.8 were kept about 1 time in 4,
 * while long confident ones were kept 6 times in 7 — so the reviewer flips the few good
 * ones instead of skipping the many. They stay in the review; nothing is dropped.
 */
export const LIKELY_SKIP = { maxSeconds: 180, minScore: 0.8 };

export function isLikelySkip(clip: Pick<ProposedClip, "start_seconds" | "end_seconds" | "score">): boolean {
  return clip.end_seconds - clip.start_seconds < LIKELY_SKIP.maxSeconds && clip.score < LIKELY_SKIP.minScore;
}

const stateName = (state: ProbeState) => state.charAt(0).toUpperCase() + state.slice(1);

/**
 * The trained detector: frames whose highlight-state probability reaches `threshold`. Each
 * clip is named after the highlight state most of its frames fall in.
 */
export function detectWithProbe(input: {
  timestamps: number[];
  vectors: Float32Array[];
  durationSeconds: number;
  probe: HighlightProbe;
  states: ProbeState[];
  threshold: number;
  options?: Partial<HighlightOptions>;
}): HighlightResult {
  const options = { ...DEFAULT_HIGHLIGHT_OPTIONS, ...input.options };
  const columns = input.states.map((state) => input.probe.classes.indexOf(state)).filter((index) => index >= 0);
  if (input.vectors.length < 4 || !columns.length) return { clips: [], curve: [] };
  const probabilities = classifyFrames(input.probe, input.vectors);
  const scores = smooth(probabilities.map((row) => columns.reduce((sum, column) => sum + row[column]!, 0)), 1);
  const labels = probabilities.map((row) => {
    const best = columns.reduce((top, column) => (row[column]! > row[top]! ? column : top), columns[0]!);
    return stateName(input.probe.classes[best]!);
  });
  const curve = downsample(scores, 240).map((value) => Math.round(value * 1000) / 1000);
  return { clips: shapeClips(input.timestamps, scores, labels, input.threshold, input.durationSeconds, options), curve };
}

/** Kept stretches in recording order, overlapping or touching ones joined into one segment. */
export function joinStretches(clips: { start_seconds: number; end_seconds: number }[]): { start: number; end: number }[] {
  const sorted = [...clips].sort((a, b) => a.start_seconds - b.start_seconds);
  const segments: { start: number; end: number }[] = [];
  for (const clip of sorted) {
    const last = segments.at(-1);
    if (last && clip.start_seconds <= last.end) last.end = Math.max(last.end, clip.end_seconds);
    else segments.push({ start: clip.start_seconds, end: clip.end_seconds });
  }
  return segments;
}
