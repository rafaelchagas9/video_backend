/** Full-recording inputs for explicit current retention; isolated from active triage/cut inference. */
import { z } from "zod";
import type { ModelFrames, ModelProposal } from "./recordings.model";
export const WHOLE_FEATURE_RECIPE = "whole-recording-v1" as const;
export const WHOLE_REVIEW_TARGET = "current_whole_recording_review" as const;
export const WHOLE_REVIEW_FEATURES = ["log_seconds", "log_proposals", "score_mean", "score_max", "proposed_coverage", "whole_dispersion_mean", "whole_transition_mean", "has_frames"] as const;
export const WHOLE_VISUAL_RECIPE = "unit_mean_unit_point_frames_entire_recording" as const;
const DIMENSION = 1152;
const schema = z.object({
  schema_version: z.literal(1), kind: z.literal("current_whole_recording_linear"), target: z.literal(WHOLE_REVIEW_TARGET),
  feature_recipe: z.literal(WHOLE_FEATURE_RECIPE), feature_names: z.array(z.string()).length(8), visual_recipe: z.literal(WHOLE_VISUAL_RECIPE),
  weights: z.array(z.number().finite()).length(8), visual_weights: z.array(z.number().finite()).length(DIMENSION), bias: z.number().finite(),
  enabled: z.boolean(), probability_calibrated: z.literal(false), automatic_action: z.literal(false),
}).strict().refine(h => h.feature_names.every((f, i) => f === WHOLE_REVIEW_FEATURES[i]), "Exact whole feature order required");
export type WholeReviewHead = z.infer<typeof schema>;
export function parseWholeReviewHead(value: unknown): WholeReviewHead { return schema.parse(value); }
export interface WholeReviewInputs { features: number[]; visualMean: number[] | null }
const norm = (v: ArrayLike<number>) => Math.sqrt(Array.from(v).reduce((s, x) => s + x * x, 0));
/** Original detector bounds and complete stored frames only. No keep counts, reasons, trims or saved coverage. */
export function recordingWholeInputs(proposals: readonly ModelProposal[], duration: number, frames: ModelFrames): WholeReviewInputs {
  const rows = proposals.filter(p => !p.id.startsWith("added-"));
  if (!Number.isFinite(duration) || duration <= 0 || rows.length > 60 || new Set(rows.map(p => p.id)).size !== rows.length || rows.some(p => !p.id || ![p.start_seconds, p.end_seconds, p.score].every(Number.isFinite) || p.start_seconds < 0 || p.end_seconds <= p.start_seconds || p.end_seconds > duration)) throw new Error("Original bounded whole-recording source required");
  const {timestamps: t, vectors: v} = frames;
  if (t.length !== v.length || v.length > 8000 || t.some((time, i) => !Number.isFinite(time) || time < 0 || time > duration || (i > 0 && time <= t[i - 1]!)) || v.some(vector => vector.length !== DIMENSION || vector.some(x => !Number.isFinite(x)))) throw new Error("Bounded full-recording numeric frames required");
  let visualMean: number[] | null = null, dispersion = 0, transition = 0;
  if (v.length) {
    if (t[0]! > 5.001 || t.some((time, i) => i > 0 && time - t[i - 1]! > 10.001) || t[t.length - 1]! + 10 < duration) throw new Error("Entire recording point-frame coverage required");
    const unit = v.map(vector => { const length = norm(vector); if (!Number.isFinite(length) || length < 1e-12) throw new Error("Zero/nonfinite point-frame embedding"); return Float64Array.from(vector, x => x / length); });
    const sum = new Float64Array(DIMENSION); for (const vector of unit) for (let d = 0; d < DIMENSION; d++) sum[d]! += vector[d]!;
    const length = norm(sum); if (length < 1e-12 * unit.length) throw new Error("Cancelling whole-recording visual mean");
    visualMean = Array.from(sum, x => x / length);
    for (const vector of unit) { let dot = 0; for (let d = 0; d < DIMENSION; d++) dot += vector[d]! * visualMean[d]!; dispersion += Math.max(0, Math.min(2, 1 - dot)); }
    dispersion /= unit.length;
    for (let i = 1; i < unit.length; i++) { let dot = 0; for (let d = 0; d < DIMENSION; d++) dot += unit[i - 1]![d]! * unit[i]![d]!; transition += Math.max(0, Math.min(2, 1 - dot)); }
    transition = unit.length > 1 ? transition / (unit.length - 1) : 0;
  }
  let covered = 0, end = 0; for (const p of [...rows].sort((a, b) => a.start_seconds - b.start_seconds || a.end_seconds - b.end_seconds)) { covered += Math.max(0, p.end_seconds - Math.max(p.start_seconds, end)); end = Math.max(end, p.end_seconds); }
  const features = [Math.log(Math.max(1, duration)), Math.log1p(rows.length), rows.length ? rows.reduce((s, p) => s + p.score, 0) / rows.length : 0, rows.length ? Math.max(...rows.map(p => p.score)) : 0, covered / duration, dispersion, transition, Number(v.length > 0)];
  if (features.some(x => !Number.isFinite(x))) throw new Error("Nonfinite whole input");
  return { features, visualMean };
}
/** Portable diagnostic score; enabled/gates are checked by future production callers before any use. */
export function scoreWholeReview(head: WholeReviewHead, input: WholeReviewInputs): number {
  const { features, visualMean } = input;
  if (features.length !== 8 || features.some(x => !Number.isFinite(x)) || (visualMean !== null && (visualMean.length !== DIMENSION || visualMean.some(x => !Number.isFinite(x)) || Math.abs(norm(visualMean) - 1) > .02))) throw new Error("Invalid whole input");
  if (visualMean === null && head.visual_weights.some(x => x !== 0)) throw new Error("Whole visual head requires full recording inputs");
  const value = head.weights.reduce((s, w, i) => s + w * features[i]!, head.bias) + (visualMean === null ? 0 : head.visual_weights.reduce((s, w, i) => s + w * visualMean[i]!, 0));
  if (!Number.isFinite(value)) throw new Error("Nonfinite whole score"); return value;
}
