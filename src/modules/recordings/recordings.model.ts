/** Versioned linear heads over stored numeric/frame features; never opens source media. */
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import { BASELINE, baselineOrder } from "./recordings.baseline";
import { RECORDING_AUDIO_PIN, readRecordingAudioCache, type RecordingAudioSource } from "./recordings.audio-cache";
import type { VisualSearchStore } from "@/modules/visual-search/visual-search.store";

export const RECORDING_FEATURES = ["log_seconds", "score", "relative_length", "relative_score", "duration_fraction", "position_fraction", "cosine_to_recording", "cosine_to_rest", "dispersion_mean", "dispersion_p90", "transition_mean", "transition_p90", "has_frames"] as const;
const WIDTH = RECORDING_FEATURES.length;
const MAX_FRAMES = 8_000;
const MAX_PROPOSALS = 60;
const DIMENSION = 1_152;
const numericVector = z.array(z.number().finite()).length(WIDTH);
const headSchema = z.object({
  weights: numericVector,
  bias: z.number().finite(),
  mean: numericVector.optional(),
  scale: z.array(z.number().finite().positive()).length(WIDTH).optional(),
  gate_passed: z.boolean(),
}).refine((head) => Boolean(head.mean) === Boolean(head.scale), "Scaling needs both mean and scale");
const audioHeadSchema = z.object({ weights: numericVector, bias: z.number().finite(), audio_weights: z.array(z.number().finite()).length(768), gate_passed: z.boolean(), model_revision: z.literal(RECORDING_AUDIO_PIN) });
const cutSchema = z.object({
  schema_version: z.literal(1), kind: z.literal("cut_offsets"), feature_names: z.array(z.string()).length(WIDTH),
  enabled: z.boolean(), mean: numericVector, scale: z.array(z.number().finite().positive()).length(WIDTH),
  weights: z.array(numericVector).length(2), bias: z.array(z.number().finite()).length(2),
  targets: z.tuple([z.literal("start_fraction"), z.literal("end_fraction")]),
  constraints: z.object({ min_seconds: z.number().finite().positive().max(60) }), fallback: z.literal("original_range"),
}).refine((value) => value.feature_names.every((name, i) => name === RECORDING_FEATURES[i]), "Unknown cut feature order");
const treeNodeSchema = z.object({ feature: z.number().int(), threshold: z.number().finite(), left: z.number().int(), right: z.number().int(), value: z.number().finite() });
const treeSchema = z.array(treeNodeSchema).min(1).max(255).refine((nodes) => {
  const visited = new Set<number>(), active = new Set<number>();
  function visit(index: number): boolean {
    if (index < 0 || index >= nodes.length || active.has(index) || visited.has(index)) return false;
    const node = nodes[index]!; visited.add(index); active.add(index);
    const valid = node.feature === -2 ? node.left === -1 && node.right === -1 : node.feature >= 0 && node.feature < WIDTH && visit(node.left) && visit(node.right);
    active.delete(index); return valid;
  }
  return visit(0) && visited.size === nodes.length;
}, "Invalid cut tree structure");
const quantileCutSchema = z.object({
  schema_version: z.literal(1), kind: z.literal("quantile_cut_offsets"), feature_names: z.array(z.string()).length(WIDTH), enabled: z.boolean(),
  targets: z.tuple([z.literal("start_fraction"), z.literal("end_fraction")]), init_bias: z.array(z.number().finite()).length(2),
  learning_rate: z.number().finite().positive().max(1), trees: z.array(z.array(treeSchema).max(1000)).length(2),
  constraints: z.object({ min_seconds: z.number().finite().positive().max(60) }), fallback: z.literal("original_range"),
}).refine((value) => value.feature_names.every((name, i) => name === RECORDING_FEATURES[i]), "Unknown quantile cut feature order");
export const RECORDING_AGGREGATES = ["log_seconds", "log_proposals", "score_mean", "score_max", "proposed_coverage", "dispersion_mean", "transition_mean", "has_frames_fraction"] as const;
const recordingSchema = z.object({
  schema_version: z.literal(1), kind: z.literal("recording_any_keep"), feature_names: z.array(z.string()).length(8),
  enabled: z.boolean(), mean: z.array(z.number().finite()).length(8), scale: z.array(z.number().finite().positive()).length(8),
  weights: z.array(z.number().finite()).length(8), bias: z.number().finite(),
  fallback: z.literal("no_recording_recommendation"), automatic_action: z.literal(false), label_interpretation: z.string().max(200),
}).refine((value) => value.feature_names.every((name, i) => name === RECORDING_AGGREGATES[i]), "Unknown recording feature order");
const artifactSchema = z.object({
  schema_version: z.literal(1),
  version: z.string().min(1).max(120),
  model_revision: z.literal("siglip2/so400m-patch16-256"),
  feature_recipe: z.literal("recording-v1"),
  features: z.array(z.string()).length(WIDTH).default([...RECORDING_FEATURES]),
  heads: z.object({ triage: headSchema, acceptance: headSchema.optional(), audio_acceptance: audioHeadSchema.optional() }).passthrough(),
  cut: z.union([cutSchema, quantileCutSchema]).optional(),
  recording_triage: recordingSchema.optional(),
}).passthrough().refine((value) => value.features.every((name, i) => name === RECORDING_FEATURES[i]), "Unknown feature order");
export type RecordingModelArtifact = z.infer<typeof artifactSchema>;
export interface ModelProposal { id: string; start_seconds: number; end_seconds: number; score: number }
export interface ModelFrames { timestamps: number[]; vectors: Float32Array[] }
export interface RecordingAssessment {
  version: string;
  target: "coarse-triage";
  applied: boolean;
  scores: { id: string; score: number }[];
  classifications: { id: string; target: "triage-potential"; probability: number; source: "numeric" | "audio" }[];
  cuts: { id: string; start_seconds: number; end_seconds: number }[];
  recording: { target: "triage-potential"; score: number; probability: number; automatic_action: false } | null;
}
export interface RecordingModelResult {
  order: { version: string; ids: string[] };
  assessment: RecordingAssessment | null;
}
export function parseRecordingModel(value: unknown): RecordingModelArtifact { return artifactSchema.parse(value); }
const mean = (values: readonly number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const dot = (a: Float64Array, b: Float64Array) => Math.max(-1, Math.min(1, a.reduce((sum, value, i) => sum + value * (b[i] ?? 0), 0)));
function unit(vector: ArrayLike<number>): Float64Array {
  const norm = Math.sqrt(Array.from(vector).reduce((sum, value) => sum + value * value, 0));
  return Float64Array.from(vector, (value) => norm ? value / norm : 0);
}
function vectorSum(vectors: Float64Array[], indices?: number[]): Float64Array {
  const sum = new Float64Array(vectors[0]?.length ?? 0);
  const ids = indices ?? vectors.map((_, index) => index);
  for (const index of ids) for (let d = 0; d < sum.length; d++) sum[d]! += vectors[index]![d]!;
  return sum;
}
function percentile90(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const position = .9 * (sorted.length - 1), low = Math.floor(position), high = Math.ceil(position);
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (position - low);
}
/** Original proposals only. Trims, verdicts, reasons and channel outcomes are not inputs. */
export function recordingModelFeatures(proposals: readonly ModelProposal[], duration: number, frames: ModelFrames): Map<string, number[]> {
  const rows = proposals.filter((proposal) => !proposal.id.startsWith("added-"));
  if (rows.length > MAX_PROPOSALS || !Number.isFinite(duration) || duration <= 0 || new Set(rows.map((row) => row.id)).size !== rows.length)
    throw new Error("Unsupported recording model input");
  if (frames.timestamps.length !== frames.vectors.length || frames.vectors.length > MAX_FRAMES ||
      frames.timestamps.some((time, i) => !Number.isFinite(time) || time < 0 || (i > 0 && time <= frames.timestamps[i - 1]!)) ||
      frames.vectors.some((vector) => !vector.length || vector.length !== frames.vectors[0]?.length || vector.some((value) => !Number.isFinite(value))))
    throw new Error("Invalid stored recording features");
  if (rows.some((row) => !Number.isFinite(row.start_seconds) || !Number.isFinite(row.end_seconds) || !Number.isFinite(row.score) || row.start_seconds < 0 || row.end_seconds <= row.start_seconds || row.end_seconds > duration + 1))
    throw new Error("Invalid original proposal");
  const normalized = frames.vectors.map(unit), recordingSum = vectorSum(normalized), recordingMean = unit(recordingSum);
  const lengths = rows.map((row) => Math.log(Math.max(1, row.end_seconds - row.start_seconds)));
  const averageLength = mean(lengths), averageScore = mean(rows.map((row) => row.score));
  return new Map(rows.map((row, i) => {
    const indices = frames.timestamps.flatMap((time, index) => time >= row.start_seconds && time <= row.end_seconds ? [index] : []);
    const clipSum = vectorSum(normalized, indices), clipMean = unit(clipSum);
    const restMean = unit(Float64Array.from(recordingSum, (value, d) => value - clipSum[d]!));
    const outsideCount = frames.timestamps.length - indices.length;
    const dispersion = indices.map((index) => Math.max(0, Math.min(2, 1 - dot(normalized[index]!, clipMean))));
    const transitions = indices.slice(1).map((index, n) => Math.max(0, Math.min(2, 1 - dot(normalized[indices[n]!]!, normalized[index]!))));
    const visual = indices.length ? [dot(clipMean, recordingMean), outsideCount ? dot(clipMean, restMean) : dot(clipMean, recordingMean), mean(dispersion), percentile90(dispersion), mean(transitions), percentile90(transitions), 1] : [0, 0, 0, 0, 0, 0, 0];
    return [row.id, [lengths[i]!, row.score, lengths[i]! - averageLength, row.score - averageScore, (row.end_seconds - row.start_seconds) / Math.max(1, duration), (row.start_seconds + row.end_seconds) / 2 / Math.max(1, duration), ...visual]];
  }));
}
export function recordingHeadScore(head: RecordingModelArtifact["heads"]["triage"], features: readonly number[]): number {
  if (features.length !== WIDTH || features.some((value) => !Number.isFinite(value))) throw new Error("Invalid model feature row");
  const score = head.weights.reduce((sum, weight, i) => sum + weight * ((features[i]! - (head.mean?.[i] ?? 0)) / (head.scale?.[i] ?? 1)), head.bias);
  if (!Number.isFinite(score)) throw new Error("Non-finite model result");
  return score;
}
export function recordingAggregateFeatures(proposals: readonly ModelProposal[], duration: number, features: Map<string, number[]>): number[] | null {
  const rows = proposals.filter((row) => features.has(row.id));
  if (!rows.length) return null;
  const ranges = rows.map((row) => [Math.max(0, row.start_seconds), Math.min(duration, row.end_seconds)]).sort((a, b) => a[0]! - b[0]!);
  let covered = 0, end = 0;
  for (const [a, b] of ranges) { covered += Math.max(0, b! - Math.max(a!, end)); end = Math.max(end, b!); }
  return [Math.log(Math.max(1, duration)), Math.log1p(rows.length), mean(rows.map((row) => row.score)), Math.max(...rows.map((row) => row.score)), covered / Math.max(1, duration), mean(rows.map((row) => features.get(row.id)![8]!)), mean(rows.map((row) => features.get(row.id)![10]!)), mean(rows.map((row) => features.get(row.id)![12]!))];
}
export function recordingCutFractions(model: NonNullable<RecordingModelArtifact["cut"]>, features: readonly number[]): number[] {
  if (features.length !== WIDTH || features.some((value) => !Number.isFinite(value))) throw new Error("Invalid cut features");
  const fractions = model.kind === "cut_offsets"
    ? model.weights.map((weights, n) => weights.reduce((sum, weight, i) => sum + weight * (features[i]! - model.mean[i]!) / model.scale[i]!, model.bias[n]!))
    : model.trees.map((trees, n) => model.init_bias[n]! + model.learning_rate * trees.reduce((sum, nodes) => {
      let index = 0;
      while (nodes[index]!.feature !== -2) {
        const node = nodes[index]!;
        index = features[node.feature]! <= node.threshold ? node.left : node.right;
      }
      return sum + nodes[index]!.value;
    }, 0));
  if (fractions.some((value) => !Number.isFinite(value))) throw new Error("Non-finite cut inference");
  return fractions;
}
function boundedCut(model: NonNullable<RecordingModelArtifact["cut"]>, row: ModelProposal, features: number[]): { id: string; start_seconds: number; end_seconds: number } {
  const fractions = recordingCutFractions(model, features);
  const span = row.end_seconds - row.start_seconds, minSpan = Math.min(model.constraints.min_seconds, span);
  const start = Math.min(row.end_seconds - minSpan, row.start_seconds + Math.max(0, Math.min(1, fractions[0]!)) * span);
  const end = Math.max(start + minSpan, Math.min(row.end_seconds, row.start_seconds + Math.max(0, Math.min(1, fractions[1]!)) * span));
  return { id: row.id, start_seconds: start, end_seconds: end };
}
export function recordingAudioHeadScore(head: NonNullable<RecordingModelArtifact["heads"]["audio_acceptance"]>, features: readonly number[], embedding: readonly number[]): number {
  if (features.length !== WIDTH || embedding.length !== 768 || [...features, ...embedding].some((value) => !Number.isFinite(value))) throw new Error("Invalid audio classifier input");
  const score = head.weights.reduce((sum, weight, i) => sum + weight * features[i]!, head.bias) + head.audio_weights.reduce((sum, weight, i) => sum + weight * embedding[i]!, 0);
  if (!Number.isFinite(score)) throw new Error("Non-finite audio classifier result");
  return score;
}
export function assessRecordingModel(artifact: RecordingModelArtifact, proposals: readonly ModelProposal[], duration: number, frames: ModelFrames, audio = new Map<string, number[]>()): RecordingModelResult {
  const features = recordingModelFeatures(proposals, duration, frames);
  const scored = proposals.filter((row) => features.has(row.id)).map((row) => ({ row, score: recordingHeadScore(artifact.heads.triage, features.get(row.id)!) }));
  const applied = artifact.heads.triage.gate_passed;
  const acceptance = artifact.heads.acceptance;
  const sigmoid = (score: number) => score >= 0 ? 1 / (1 + Math.exp(-score)) : Math.exp(score) / (1 + Math.exp(score));
  const classifications = scored.flatMap<RecordingAssessment["classifications"][number]>(({ row }) => {
    const embedding = audio.get(row.id), head = artifact.heads.audio_acceptance;
    if (head?.gate_passed && embedding) return [{ id: row.id, target: "triage-potential" as const, probability: sigmoid(recordingAudioHeadScore(head, features.get(row.id)!, embedding)), source: "audio" as const }];
    return acceptance?.gate_passed ? [{ id: row.id, target: "triage-potential" as const, probability: sigmoid(recordingHeadScore(acceptance, features.get(row.id)!)), source: "numeric" as const }] : [];
  });
  const cuts = artifact.cut?.enabled ? scored.map(({ row }) => boundedCut(artifact.cut!, row, features.get(row.id)!)) : [];
  const aggregate = recordingAggregateFeatures(proposals, duration, features), recordingHead = artifact.recording_triage;
  let recording: RecordingAssessment["recording"] = null;
  if (recordingHead?.enabled && aggregate) {
    const score = recordingHead.weights.reduce((sum, weight, i) => sum + weight * (aggregate[i]! - recordingHead.mean[i]!) / recordingHead.scale[i]!, recordingHead.bias);
    if (!Number.isFinite(score)) throw new Error("Non-finite recording inference");
    recording = { target: "triage-potential", score, probability: score >= 0 ? 1 / (1 + Math.exp(-score)) : Math.exp(score) / (1 + Math.exp(score)), automatic_action: false };
  }
  return {
    order: applied ? { version: artifact.version, ids: [...scored].sort((a, b) => b.score - a.score || a.row.start_seconds - b.row.start_seconds || a.row.id.localeCompare(b.row.id)).map(({ row }) => row.id) } : { version: BASELINE.version, ids: baselineOrder(proposals) },
    assessment: { version: artifact.version, target: "coarse-triage", applied, scores: scored.map(({ row, score }) => ({ id: row.id, score })), classifications, cuts, recording },
  };
}
interface Loaded { artifact: RecordingModelArtifact; fingerprint: string }
let loaded: { identity: string; model: Loaded | null } | null = null;
export async function loadRecordingModel(path = process.env.RECORDINGS_MODEL?.trim() || "./data/models/recordings-model.json"): Promise<Loaded | null> {
  try {
    const before = await stat(path);
    if (!before.isFile() || before.size > 2 * 1024 * 1024) return null;
    const identity = `${path}:${before.mtimeMs}:${before.size}`;
    if (loaded?.identity === identity) return loaded.model;
    const content = await readFile(path, "utf8"), after = await stat(path);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) return null;
    const model = { artifact: parseRecordingModel(JSON.parse(content)), fingerprint: createHash("sha256").update(content).digest("hex") };
    loaded = { identity, model };
    return model;
  } catch { return null; }
}
const results = new Map<string, RecordingModelResult>();
const pending = new Map<string, Promise<RecordingModelResult>>();
/** Only already indexed vectors are read; cache holds small scores rather than frame matrices. */
export async function recordingModelReview(input: { videoId: number; analyzedAt: string; duration: number; proposals: readonly ModelProposal[]; modelPath?: string; source?: RecordingAudioSource; audioCacheRoot?: string; store: Pick<VisualSearchStore, "indexed" | "videoFrames"> }): Promise<RecordingModelResult> {
  const fallback = { order: { version: BASELINE.version, ids: baselineOrder(input.proposals) }, assessment: null };
  const model = await loadRecordingModel(input.modelPath);
  if (!model) return fallback;
  try {
    const index = (await input.store.indexed([input.videoId])).get(input.videoId);
    if (!index || index.modelRevision !== model.artifact.model_revision || index.frameCount > MAX_FRAMES) return fallback;
    const audio = model.artifact.heads.audio_acceptance?.gate_passed ? await readRecordingAudioCache({ identity: { video_id: input.videoId, analyzed_at: input.analyzedAt, index_model_revision: index.modelRevision, storyboard_generated_at: index.storyboardGeneratedAt.toISOString(), frame_count: index.frameCount, audio_model_revision: RECORDING_AUDIO_PIN }, proposals: input.proposals, source: input.source, cacheRoot: input.audioCacheRoot }) : null;
    const identity = createHash("sha256").update(JSON.stringify([audio?.fingerprint, input.videoId, input.analyzedAt, input.duration, input.proposals, index.storyboardGeneratedAt, index.frameCount, index.intervalSeconds, model.fingerprint])).digest("hex");
    const cached = results.get(identity); if (cached) return cached;
    const running = pending.get(identity); if (running) return await running;
    // Limit concurrent frame loads as well as the completed score cache.
    if (pending.size >= 2) return fallback;
    const operation = (async () => {
      const frames = await input.store.videoFrames(input.videoId);
      if (frames.vectors.length !== index.frameCount || frames.vectors.some((vector) => vector.length !== DIMENSION)) throw new Error("Incompatible production embedding width");
      const result = assessRecordingModel(model.artifact, input.proposals, input.duration, frames, audio?.embeddings);
      results.set(identity, result);
      if (results.size > 32) results.delete(results.keys().next().value!);
      return result;
    })();
    pending.set(identity, operation);
    try { return await operation; } finally { pending.delete(identity); }
  } catch { return fallback; }
}
