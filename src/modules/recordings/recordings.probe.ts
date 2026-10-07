/**
 * The trained highlight detector: a linear probe over the SigLIP2 frame embeddings the visual
 * index already stores, fitted on hand-labelled recording frames (vision-lab/export_probe.py).
 *
 * Each frame is classified into one stream state — idle, tease, nude, explicit — from its own
 * embedding plus the mean of its neighbours (±`context_radius` frames), so a moment is judged
 * with the 20 seconds around it. In held-out tests it found ~9 in 10 minutes of highlight where
 * the text-prompt detector found 2 in 10.
 */
import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import { env } from "@/config/env";
import { logger } from "@/utils/logger";

export const PROBE_STATES = ["idle", "tease", "nude", "explicit"] as const;
export type ProbeState = (typeof PROBE_STATES)[number];

const probeSchema = z.object({
  version: z.string(),
  model_revision: z.string(),
  classes: z.array(z.enum(PROBE_STATES)).length(PROBE_STATES.length),
  context_radius: z.number().int().min(0).max(10),
  dimension: z.number().int().positive(),
  weights: z.array(z.array(z.number())),
  bias: z.array(z.number()),
  labelled_frames: z.number().int(),
  labelled_recordings: z.number().int(),
  metrics: z.object({ auroc: z.number(), clip_precision: z.number(), clip_recall: z.number() }).nullable(),
});

export interface HighlightProbe {
  version: string;
  modelRevision: string;
  classes: ProbeState[];
  contextRadius: number;
  dimension: number;
  weights: Float32Array[];
  bias: number[];
  labelledFrames: number;
  labelledRecordings: number;
  metrics: { auroc: number; clip_precision: number; clip_recall: number } | null;
}

let cached: { mtimeMs: number; probe: HighlightProbe } | null = null;

/** The exported probe, reloaded when the file changes; null when none has been exported. */
export async function loadHighlightProbe(path = env.RECORDINGS_HIGHLIGHT_PROBE): Promise<HighlightProbe | null> {
  const info = await stat(path).catch(() => null);
  if (!info) return null;
  if (cached?.mtimeMs === info.mtimeMs) return cached.probe;
  try {
    const raw = probeSchema.parse(JSON.parse(await readFile(path, "utf8")));
    const width = raw.dimension * 2;
    if (raw.weights.length !== raw.classes.length || raw.weights.some((row) => row.length !== width) || raw.bias.length !== raw.classes.length)
      throw new Error("weights do not match the declared shape");
    const probe: HighlightProbe = {
      version: raw.version,
      modelRevision: raw.model_revision,
      classes: raw.classes,
      contextRadius: raw.context_radius,
      dimension: raw.dimension,
      weights: raw.weights.map((row) => Float32Array.from(row)),
      bias: raw.bias,
      labelledFrames: raw.labelled_frames,
      labelledRecordings: raw.labelled_recordings,
      metrics: raw.metrics,
    };
    cached = { mtimeMs: info.mtimeMs, probe };
    return probe;
  } catch (error) {
    logger.warn({ err: error, path }, "Ignoring an unreadable highlight probe");
    return null;
  }
}

/** Per-frame state probabilities, rows in `probe.classes` order. */
export function classifyFrames(probe: HighlightProbe, vectors: Float32Array[]): Float32Array[] {
  const { dimension, contextRadius: radius } = probe;
  // Prefix sums give each frame's neighbourhood mean in O(dimension).
  const prefix: Float64Array[] = [new Float64Array(dimension)];
  for (const vector of vectors) {
    const next = Float64Array.from(prefix.at(-1)!);
    for (let d = 0; d < dimension; d++) next[d]! += vector[d] ?? 0;
    prefix.push(next);
  }
  return vectors.map((vector, index) => {
    const low = Math.max(0, index - radius);
    const high = Math.min(vectors.length, index + radius + 1);
    const count = high - low;
    const logits = probe.weights.map((row, k) => {
      let sum = probe.bias[k]!;
      for (let d = 0; d < dimension; d++) {
        sum += row[d]! * (vector[d] ?? 0);
        sum += (row[dimension + d]! * (prefix[high]![d]! - prefix[low]![d]!)) / count;
      }
      return sum;
    });
    const top = Math.max(...logits);
    const exp = logits.map((value) => Math.exp(value - top));
    const total = exp.reduce((a, b) => a + b, 0);
    return Float32Array.from(exp.map((value) => value / total));
  });
}

/**
 * Probability a highlight state needs, from the shared sensitivity setting (whose presets are
 * 1.0 / 1.4 / 2.0). Balanced lands on 0.55, the threshold that scored best in held-out tests.
 */
export function probeThreshold(sensitivity: number): number {
  return Math.min(0.9, Math.max(0.2, 0.55 + (sensitivity - 1.4) * 0.25));
}
