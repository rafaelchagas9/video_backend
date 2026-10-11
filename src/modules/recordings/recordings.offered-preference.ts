/**
 * Pure relative scoring of an exact offered version. This module neither loads a model nor
 * activates one: the caller must bind the supplied proposals/frames to their verified generation.
 * Scores cannot be interpreted as acceptance, whole-recording worth or discard probabilities.
 */
import { z } from "zod";
import { recordingModelFeatures, type ModelFrames, type ModelProposal } from "./recordings.model";

const NUMERIC_WIDTH = 13;
const VISUAL_WIDTH = 1152;
const MAX_FRAMES = 8000;
const MAX_PROPOSALS = 60;
export const offeredPreferenceHeadSchema = z.object({
  schema_version: z.literal(1),
  kind: z.literal("offered_version_preference_linear"),
  numeric_weights: z.array(z.number().finite()).length(NUMERIC_WIDTH),
  visual_weights: z.array(z.number().finite()).length(VISUAL_WIDTH),
  duration_weights: z.array(z.number().finite()).length(2),
  bias: z.number().finite(),
  soft_preferred_seconds: z.tuple([z.literal(180), z.literal(900)]),
  duration_recipe: z.literal("log_hinges_180_900_v1"),
  feature_recipe: z.literal("recording-v1-replace_exact_offered_proposal"),
  visual_recipe: z.literal("unit_mean_unit_frames_inside_exact_offered_range"),
  target: z.literal("preferred_version_if_keep_one"),
  probability_calibrated: z.literal(false),
  automatic_action: z.literal(false),
}).strict();
export type OfferedPreferenceHead = z.infer<typeof offeredPreferenceHeadSchema>;
export function parseOfferedPreferenceHead(raw: unknown): OfferedPreferenceHead { return offeredPreferenceHeadSchema.parse(raw); }

export interface OfferedVersionInput {
  originalProposalId: string;
  proposals: readonly ModelProposal[];
  recordingDuration: number;
  offeredRange: readonly [number, number];
  frames: ModelFrames;
}
export interface OfferedPreferenceFeatures { numeric: number[]; visual: number[]; duration: [number, number] }

/** Inclusive point-frame pooling is the fixed training recipe; there is no extrapolated support. */
export function offeredPreferenceFeatures(input: OfferedVersionInput): OfferedPreferenceFeatures {
  const { originalProposalId, proposals, recordingDuration, offeredRange, frames } = input;
  if (!Number.isFinite(recordingDuration) || recordingDuration <= 0 || !proposals.length || proposals.length > MAX_PROPOSALS ||
      !originalProposalId || originalProposalId.startsWith("added-") ||
      proposals.some((row) => typeof row.id !== "string" || !row.id || row.id.startsWith("added-") || !Number.isFinite(row.start_seconds) || !Number.isFinite(row.end_seconds) || !Number.isFinite(row.score) || row.start_seconds < 0 || row.end_seconds <= row.start_seconds || row.end_seconds > recordingDuration) ||
      new Set(proposals.map((row) => row.id)).size !== proposals.length) throw new Error("Invalid immutable original proposal universe");
  const original = proposals.find((row) => row.id === originalProposalId);
  const [start, end] = offeredRange;
  if (!original || offeredRange.length !== 2 || !Number.isFinite(start) || !Number.isFinite(end) || start < original.start_seconds || end > original.end_seconds || end <= start) throw new Error("Offered range must belong to its exact original proposal");
  if (!frames.timestamps.length || frames.timestamps.length !== frames.vectors.length || frames.timestamps.length > MAX_FRAMES ||
      frames.timestamps.some((time, index) => !Number.isFinite(time) || time < 0 || time > recordingDuration || (index > 0 && time <= frames.timestamps[index - 1]!)) ||
      frames.vectors.some((vector) => vector.length !== VISUAL_WIDTH || vector.some((value) => !Number.isFinite(value)))) throw new Error("Invalid bounded stored frames");
  const total = new Float64Array(VISUAL_WIDTH);
  let supported = 0;
  for (let index = 0; index < frames.vectors.length; index++) {
    const vector = frames.vectors[index]!;
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    if (!Number.isFinite(norm) || norm <= 0) throw new Error("Invalid zero stored frame vector");
    const timestamp = frames.timestamps[index]!;
    if (timestamp < start || timestamp > end) continue;
    supported++;
    for (let d = 0; d < VISUAL_WIDTH; d++) total[d]! += vector[d]! / norm;
  }
  const norm = Math.sqrt(total.reduce((sum, value) => sum + value * value, 0));
  if (!supported || !Number.isFinite(norm) || norm <= 0) throw new Error("Offered version lacks a nondegenerate visual mean");
  const visual = Array.from(total, (value) => value / norm);
  const replaced = proposals.map((row) => row.id === originalProposalId ? { ...row, start_seconds: start, end_seconds: end } : row);
  const numeric = recordingModelFeatures(replaced, recordingDuration, frames).get(originalProposalId);
  if (!numeric || numeric.length !== NUMERIC_WIDTH || numeric.some((value) => !Number.isFinite(value))) throw new Error("Invalid offered numeric features");
  const seconds = end - start;
  const duration: [number, number] = [Math.max(0, Math.log(180 / seconds)), Math.max(0, Math.log(seconds / 900))];
  if (duration.some((value) => !Number.isFinite(value))) throw new Error("Non-finite offered duration features");
  return { numeric, visual, duration };
}

/** No sigmoid: this is a comparable relative utility, not an absolute probability. */
export function scoreOfferedPreference(rawHead: unknown, input: OfferedVersionInput): number {
  const head = parseOfferedPreferenceHead(rawHead);
  const features = offeredPreferenceFeatures(input);
  const score = head.bias + head.numeric_weights.reduce((sum, weight, i) => sum + weight * features.numeric[i]!, 0)
    + head.visual_weights.reduce((sum, weight, i) => sum + weight * features.visual[i]!, 0)
    + head.duration_weights.reduce((sum, weight, i) => sum + weight * features.duration[i]!, 0);
  if (!Number.isFinite(score)) throw new Error("Non-finite offered preference result");
  return score;
}
