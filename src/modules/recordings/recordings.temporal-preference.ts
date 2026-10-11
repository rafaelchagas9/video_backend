/**
 * Pure sampled-evidence challenger selection; no artifact loading, extraction, or activation.
 * Port of the pinned temporal diagnostic's propose() recipe. A challenger is neither a
 * keep probability nor continuous face/action truth. The caller verifies source receipts,
 * full-context state inference, original proposal identity, and the frozen control policy.
 */
export const TEMPORAL_PREFERENCE_RECIPE = "observed_temporal_face_action_same_length_challenger_v1" as const;
export const TEMPORAL_PREFERENCE_TARGET = "same_duration_temporal_challenger" as const;
export const TEMPORAL_DIAGNOSTIC_SOURCE_SHA256 = "6205fbee5cd8f58e5d86efc0470c3f350a2137293c7258da778dbb167dafb60d";
export const TEMPORAL_STATE_PROBE_SHA256 = "da968dbf33bc6308f64e67749aea6efcec167305ce8fe3fe569f353c2b0201f4";
const MAX_FRAMES = 8000;
type NumericPoints = readonly number[] | Float32Array | Float64Array;
export type TemporalRange = readonly [number, number];
export interface TemporalFaceObservation {
  index: number;
  timestamp: number;
  detected: boolean;
  max_confidence: number;
}
export interface TemporalPreferenceInput {
  /** Canonical, caller-verified exact-generation identity, never a video ID alone. */
  generationIdentity: string;
  stateGenerationIdentity: string;
  faceGenerationIdentity: string;
  probeSha256: string;
  /** Complete actual recording point timeline and pinned full-context state probabilities. */
  timestamps: NumericPoints;
  /** Columns: idle, tease, nude, explicit. Missing states must not be filled with zero. */
  probabilities: readonly NumericPoints[];
  /** Only observed points; missing face observations remain unknown. */
  faces: readonly TemporalFaceObservation[];
  original: TemporalRange;
  /** Immutable offered control; relocation retains this exact duration, without a 15m cap. */
  control: TemporalRange;
}
export interface TemporalJointAnchor { index: number; timestamp: number; joint_proxy: number }
export interface TemporalCoverage {
  full_frame_points: number;
  observed_face_points: number;
  face_unknown_frame_points: number;
  max_observed_gap_seconds: number;
  continuous_face_coverage_known: false;
}
export interface TemporalPreferenceResult {
  target: typeof TEMPORAL_PREFERENCE_TARGET;
  recipe: typeof TEMPORAL_PREFERENCE_RECIPE;
  generation_identity: string;
  probe_sha256: string;
  probability_calibrated: false;
  status: "no_observed_joint_anchor" | "single_observed_joint_anchor_insufficient" | "observed_joint_anchors_no_eligible_cluster" | "distinct_sampled_episode_challenger";
  candidate_range: [number, number] | null;
  control_range: [number, number];
  original_range: [number, number];
  joint_anchor_count: number;
  observed_joint_anchors: TemporalJointAnchor[];
  single_anchor_is_not_user_minimum: true;
  sampled_clusters: TemporalJointAnchor[][];
  coverage_original: TemporalCoverage;
  coverage_control: TemporalCoverage;
  missing_face_is_unknown: true;
  automatic_action: false;
  retained_omitted_joint_points?: TemporalJointAnchor[];
  coverage_candidate?: TemporalCoverage;
  control_iou?: number;
  action_proxy_point_mass?: {
    control: number;
    candidate: number;
    original: number;
    elapsed_time_coverage: false;
    human_action_truth: false;
  };
}
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const numericPoints = (value: unknown): value is NumericPoints => Array.isArray(value) || value instanceof Float32Array || value instanceof Float64Array;
const validRange = (value: TemporalRange) => Array.isArray(value) && value.length === 2 && value.every(finite);

/** Python round(x) without ndigits uses ties to even; Math.round differs at half-grid points. */
function roundToEven(value: number): number {
  const lower = Math.floor(value), fraction = value - lower;
  return fraction < .5 ? lower : fraction > .5 ? lower + 1 : lower % 2 === 0 ? lower : lower + 1;
}
function intersectionOverUnion(a: TemporalRange, b: TemporalRange): number {
  const intersection = Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0]));
  return intersection / (a[1] - a[0] + b[1] - b[0] - intersection);
}
function coverage(timestamps: NumericPoints, observed: readonly number[], bounds: TemporalRange): TemporalCoverage {
  let full = 0;
  for (const time of timestamps) if (bounds[0] <= time && time <= bounds[1]) full++;
  const seen = observed.filter(time => bounds[0] <= time && time <= bounds[1]).sort((a, b) => a - b);
  let previous = bounds[0], maximumGap = 0;
  for (const time of seen) { maximumGap = Math.max(maximumGap, time - previous); previous = time; }
  maximumGap = Math.max(maximumGap, bounds[1] - previous);
  return { full_frame_points: full, observed_face_points: seen.length, face_unknown_frame_points: full - seen.length, max_observed_gap_seconds: maximumGap, continuous_face_coverage_known: false };
}

/**
 * Exact same-duration relocation over observed joint anchors. Thresholds identify a
 * diagnostic challenger, not a user minimum or an automatic face constraint. Valid
 * inputs are bounded numeric receipts supplied by the caller; this function performs no IO.
 */
export function proposeTemporalPreference(input: TemporalPreferenceInput): TemporalPreferenceResult {
  const { generationIdentity, stateGenerationIdentity, faceGenerationIdentity, probeSha256, timestamps, probabilities, faces, original, control } = input;
  if (typeof generationIdentity !== "string" || !/^[a-f0-9]{64}$/.test(generationIdentity) || stateGenerationIdentity !== generationIdentity || faceGenerationIdentity !== generationIdentity || probeSha256 !== TEMPORAL_STATE_PROBE_SHA256)
    throw new Error("Exact verified face/state generation and pinned probe required");
  if (!numericPoints(timestamps) || !timestamps.length || timestamps.length > MAX_FRAMES || !Array.isArray(probabilities) || probabilities.length !== timestamps.length || !Array.isArray(faces) || faces.length > timestamps.length)
    throw new Error("Bounded full numeric timeline/state/observed-face arrays required");
  for (let i = 0; i < timestamps.length; i++) {
    const time = timestamps[i]!, row = probabilities[i];
    if (!finite(time) || time < 0 || (i > 0 && time <= timestamps[i - 1]!) || !numericPoints(row) || row.length !== 4)
      throw new Error("Ordered finite full timeline and four state columns required");
    let total = 0;
    for (const probability of row) {
      if (!finite(probability) || probability < 0 || probability > 1) throw new Error("Finite state simplex required");
      total += probability;
    }
    if (Math.abs(total - 1) > 1e-6) throw new Error("Finite state simplex required");
  }
  if (!validRange(original) || !validRange(control) || !(0 <= original[0] && original[0] <= control[0] && control[0] < control[1] && control[1] <= original[1]) || !finite(control[1] - control[0]) || control[1] - control[0] < 180)
    throw new Error("Legal immutable original/control range required");
  const seen = new Map<number, TemporalFaceObservation>(), anchors: TemporalJointAnchor[] = [];
  for (const face of faces) {
    if (!face || !Number.isInteger(face.index) || seen.has(face.index) || face.index < 0 || face.index >= timestamps.length || !finite(face.timestamp) || face.timestamp !== timestamps[face.index] || typeof face.detected !== "boolean" || !finite(face.max_confidence) || face.max_confidence < 0 || face.max_confidence > 1)
      throw new Error("Exact unique observed face index/timestamp/confidence required");
    seen.set(face.index, face);
    const probability = probabilities[face.index]![3]!;
    if (original[0] <= face.timestamp && face.timestamp <= original[1] && face.detected && probability >= .55)
      anchors.push({ index: face.index, timestamp: face.timestamp, joint_proxy: face.max_confidence * probability });
  }
  anchors.sort((a, b) => a.timestamp - b.timestamp);
  const clusters: TemporalJointAnchor[][] = [];
  for (const anchor of anchors) {
    const previous = clusters.at(-1);
    if (!previous || anchor.timestamp - previous.at(-1)!.timestamp > 90) clusters.push([anchor]);
    else previous.push(anchor);
  }
  const length = control[1] - control[0];
  let best: { weight: number; bounds: [number, number]; retained: TemporalJointAnchor[] } | null = null;
  for (const cluster of clusters) {
    const omitted = cluster.filter(anchor => !(control[0] <= anchor.timestamp && anchor.timestamp <= control[1]));
    if (omitted.length < 2) continue;
    const midpoint = (omitted[0]!.timestamp + omitted.at(-1)!.timestamp) / 2;
    let start = original[0] + 5 * roundToEven((midpoint - length / 2 - original[0]) / 5);
    if (!finite(midpoint) || !finite(start)) throw new Error("Non-finite temporal candidate arithmetic");
    start = Math.max(original[0], Math.min(start, original[1] - length));
    const bounds: [number, number] = [start, start + length];
    if (!finite(bounds[1])) throw new Error("Non-finite temporal candidate arithmetic");
    const retained = omitted.filter(anchor => bounds[0] <= anchor.timestamp && anchor.timestamp <= bounds[1]);
    if (retained.length < 2 || Math.abs(bounds[0] - control[0]) < 30 || intersectionOverUnion(bounds, control) > .8) continue;
    const weight = retained.reduce((sum, anchor) => sum + anchor.joint_proxy, 0);
    if (!best || weight > best.weight || (weight === best.weight && (retained.length > best.retained.length || (retained.length === best.retained.length && retained[0]!.timestamp < best.retained[0]!.timestamp))))
      best = { weight, bounds, retained };
  }
  const observed = Array.from(seen.values(), face => face.timestamp).filter(time => original[0] <= time && time <= original[1]);
  const result: TemporalPreferenceResult = {
    target: TEMPORAL_PREFERENCE_TARGET, recipe: TEMPORAL_PREFERENCE_RECIPE, generation_identity: generationIdentity, probe_sha256: probeSha256, probability_calibrated: false,
    status: !anchors.length ? "no_observed_joint_anchor" : anchors.length === 1 ? "single_observed_joint_anchor_insufficient" : "observed_joint_anchors_no_eligible_cluster",
    candidate_range: null, control_range: [control[0], control[1]], original_range: [original[0], original[1]], joint_anchor_count: anchors.length,
    observed_joint_anchors: anchors, single_anchor_is_not_user_minimum: true, sampled_clusters: clusters,
    coverage_original: coverage(timestamps, observed, original), coverage_control: coverage(timestamps, observed, control), missing_face_is_unknown: true, automatic_action: false,
  };
  if (best) {
    result.status = "distinct_sampled_episode_challenger";
    result.candidate_range = best.bounds;
    result.retained_omitted_joint_points = best.retained;
    result.coverage_candidate = coverage(timestamps, observed, best.bounds);
    result.control_iou = intersectionOverUnion(best.bounds, control);
    const mass = (bounds: TemporalRange) => {
      let sum = 0;
      for (let i = 0; i < timestamps.length; i++) if (bounds[0] <= timestamps[i]! && timestamps[i]! <= bounds[1]) sum += probabilities[i]![3]!;
      return sum;
    };
    result.action_proxy_point_mass = { control: mass(control), candidate: mass(best.bounds), original: mass(original), elapsed_time_coverage: false, human_action_truth: false };
  }
  return result;
}
