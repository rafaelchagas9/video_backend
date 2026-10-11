/** Read a validated advisory export only. Never generates controls, reads pixels, or runs inference. */
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import type { IndexedVideo } from "@/modules/visual-search/visual-search.store";
import type { ModelProposal } from "./recordings.model";
import { TEMPORAL_DIAGNOSTIC_SOURCE_SHA256, TEMPORAL_PREFERENCE_RECIPE, TEMPORAL_PREFERENCE_TARGET, TEMPORAL_STATE_PROBE_SHA256 } from "./recordings.temporal-preference";

const MAX_BYTES = 2 * 1024 * 1024;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const seconds = z.number().finite().nonnegative();
const range = z.tuple([seconds, seconds]).refine(r => r[1] > r[0]);
const proposalSchema = z.object({ id: z.string().min(1).max(100), start: seconds, end: seconds, score: z.number().finite() }).strict().refine(p => p.end > p.start && !p.id.startsWith("added-"));
const identitySchema = z.object({
  video_id: z.number().int().positive(), analyzed_at: z.string().datetime(), duration: z.number().finite().positive(),
  source_fingerprint: z.object({ size_bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), mtime_ns: z.string().regex(/^\d+$/), path_identity_sha256: hash }).strict(),
  index: z.object({ model_revision: z.literal("siglip2/so400m-patch16-256"), storyboard_generated_at: z.string().datetime(), indexed_at: z.string().datetime(), interval_seconds: z.number().finite().positive(), frame_count: z.number().int().positive().max(8000) }).strict(),
  proposals: z.array(proposalSchema).min(1).max(60),
}).passthrough().refine(v => new Set(v.proposals.map(p => p.id)).size === v.proposals.length && v.proposals.every(p => p.end <= v.duration));
const entrySchema = z.object({
  generation_identity: hash,
  /** Exact canonical Python identity JSON; hashing it avoids Python/JS float serialization differences. */
  generation_identity_json: z.string().min(1).max(256 * 1024),
  original_proposal_id: z.string().min(1).max(100), original: range, control: range, candidate: range, candidate_id: hash,
  prior_control: z.object({ origin: z.literal("frozen_prior_C_primary"), head_sha256: z.literal("e681be589ec7778c7c09b0273a367012c8ba4278989edde41b576b7fe5495d43"), receipt_sha256: hash }).strict(),
  frame_checkpoint_sha256: hash, face_checkpoint_sha256: hash, selector_report_sha256: hash,
  observed_joint_anchor_count: z.number().int().min(2).max(8000), missing_face_is_unknown: z.literal(true),
}).strict();
const artifactSchema = z.object({
  schema_version: z.literal(1), version: z.string().min(1).max(120), enabled: z.boolean(), target: z.literal(TEMPORAL_PREFERENCE_TARGET),
  scope: z.literal("frozen_prior_control_generations_only"), selector_recipe: z.literal(TEMPORAL_PREFERENCE_RECIPE), selector_source_sha256: z.literal(TEMPORAL_DIAGNOSTIC_SOURCE_SHA256), probe_sha256: z.literal(TEMPORAL_STATE_PROBE_SHA256),
  probability_calibrated: z.literal(false), automatic_action: z.literal(false),
  /** Export approval is explicit; availability alone never promotes an exploratory diagnostic. */
  validation: z.object({ status: z.literal("approved_advisory"), answered_pairs: z.number().int().min(50).max(10000), receipt_sha256: hash }).strict(),
  entries: z.array(entrySchema).max(128),
}).strict();
export type RecordingTemporalArtifact = z.infer<typeof artifactSchema>;
export function parseRecordingTemporalArtifact(raw: unknown): RecordingTemporalArtifact {
  const artifact = artifactSchema.parse(raw), used = new Set<string>();
  for (const entry of artifact.entries) {
    if (digest(entry.generation_identity_json) !== entry.generation_identity) throw new Error("Temporal identity checksum differs");
    const identity = identitySchema.parse(JSON.parse(entry.generation_identity_json));
    const original = identity.proposals.find(p => p.id === entry.original_proposal_id);
    const key = `${entry.generation_identity}:${entry.original_proposal_id}`;
    if (used.has(key) || !original || original.start !== entry.original[0] || original.end !== entry.original[1]) throw new Error("Exact unique original temporal proposal required");
    used.add(key);
    const duration = entry.control[1] - entry.control[0], candidateDuration = entry.candidate[1] - entry.candidate[0];
    if (duration < 180 || Math.abs(duration - candidateDuration) > 1e-6 || entry.control[0] < original.start || entry.control[1] > original.end || entry.candidate[0] < original.start || entry.candidate[1] > original.end)
      throw new Error("Temporal candidate must retain its frozen control duration and original bounds");
    const intersection = Math.max(0, Math.min(entry.control[1], entry.candidate[1]) - Math.max(entry.control[0], entry.candidate[0]));
    if (Math.abs(entry.control[0] - entry.candidate[0]) < 30 || intersection / (duration + candidateDuration - intersection) > .8) throw new Error("Temporal export must contain a distinct same-duration challenger");
  }
  return artifact;
}
export interface RecordingTemporalCandidate {
  id: string; candidate_id: string; original: [number, number]; control: [number, number]; range: [number, number];
  generation_identity: string; frame_checkpoint_sha256: string; face_checkpoint_sha256: string; prior_control_receipt_sha256: string; selector_report_sha256: string;
  missing_face_is_unknown: true;
}
export interface RecordingTemporalVersions {
  version: string; target: typeof TEMPORAL_PREFERENCE_TARGET; scope: "frozen_prior_control_generations_only" | "current_generation_controls"; analyzed_at: string;
  selector_recipe: typeof TEMPORAL_PREFERENCE_RECIPE; selector_source_sha256: string; probe_sha256: string; artifact_sha256: string;
  probability_calibrated: false; automatic_action: false; candidates: RecordingTemporalCandidate[];
}
export interface RecordingTemporalReadInput {
  videoId: number; analyzedAt: string; duration: number; proposals: readonly ModelProposal[];
  source?: { path: string; sizeBytes: number };
  index: () => Promise<(IndexedVideo & { indexedAt?: Date }) | undefined>;
  artifactPath?: string;
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
let loaded: { path: string; identity: string; artifact: RecordingTemporalArtifact; fingerprint: string } | null = null;
export async function readRecordingTemporalVersions(input: RecordingTemporalReadInput): Promise<RecordingTemporalVersions | null> {
  // Tests without a private storage root cannot inspect the real workspace artifact.
  const root = process.env.NODE_ENV === "test" ? process.env.TEST_STORAGE_ROOT : process.cwd();
  if (!input.artifactPath && !root) return null;
  const path = input.artifactPath ?? resolve(root!, "data/models/recording-temporal-versions.json");
  try {
    const before = await stat(path, { bigint: true });
    if (!before.isFile() || before.size <= 0 || before.size > BigInt(MAX_BYTES)) return null;
    const identity = `${before.dev}:${before.ino}:${before.size}:${before.mtimeNs}:${before.ctimeNs}`;
    let artifact = loaded?.path === path && loaded.identity === identity ? loaded.artifact : null;
    let fingerprint = loaded?.path === path && loaded.identity === identity ? loaded.fingerprint : "";
    if (!artifact) {
      const contents = await readFile(path, "utf8"), after = await stat(path, { bigint: true });
      if (`${after.dev}:${after.ino}:${after.size}:${after.mtimeNs}:${after.ctimeNs}` !== identity || Buffer.byteLength(contents) > MAX_BYTES) return null;
      artifact = parseRecordingTemporalArtifact(JSON.parse(contents));fingerprint = digest(contents);
      loaded = { path, identity, artifact, fingerprint };
    }
    if (!artifact.enabled || !input.source) return null;
    const entries = artifact.entries.map(entry => ({ entry, generation: identitySchema.parse(JSON.parse(entry.generation_identity_json)) })).filter(({ generation }) => generation.video_id === input.videoId && Date.parse(generation.analyzed_at) === Date.parse(input.analyzedAt));
    if (!entries.length) return null;
    const [index, source] = await Promise.all([input.index(), stat(input.source.path, { bigint: true })]);
    if (!index?.indexedAt || !source.isFile() || source.size > BigInt(Number.MAX_SAFE_INTEGER) || Number(source.size) !== input.source.sizeBytes) return null;
    const candidates: RecordingTemporalCandidate[] = [];
    for (const { entry, generation } of entries) {
      const frozen = generation.index, sourceIdentity = generation.source_fingerprint;
      if (generation.duration !== input.duration || sourceIdentity.size_bytes !== Number(source.size) || sourceIdentity.mtime_ns !== source.mtimeNs.toString() || sourceIdentity.path_identity_sha256 !== digest(input.source.path) ||
          frozen.model_revision !== index.modelRevision || Date.parse(frozen.storyboard_generated_at) !== index.storyboardGeneratedAt.getTime() || Date.parse(frozen.indexed_at) !== index.indexedAt.getTime() || frozen.interval_seconds !== index.intervalSeconds || frozen.frame_count !== index.frameCount ||
          generation.proposals.length !== input.proposals.length || generation.proposals.some((p, i) => { const live = input.proposals[i];return !live || p.id !== live.id || p.start !== live.start_seconds || p.end !== live.end_seconds || p.score !== live.score; })) return null;
      candidates.push({ id: entry.original_proposal_id, candidate_id: entry.candidate_id, original: [...entry.original], control: [...entry.control], range: [...entry.candidate], generation_identity: entry.generation_identity, frame_checkpoint_sha256: entry.frame_checkpoint_sha256, face_checkpoint_sha256: entry.face_checkpoint_sha256, prior_control_receipt_sha256: entry.prior_control.receipt_sha256, selector_report_sha256: entry.selector_report_sha256, missing_face_is_unknown: true });
    }
    if (new Set(candidates.map(c => c.id)).size !== candidates.length) return null;
    return { version: artifact.version, target: artifact.target, scope: artifact.scope, analyzed_at: input.analyzedAt, selector_recipe: artifact.selector_recipe, selector_source_sha256: artifact.selector_source_sha256, probe_sha256: artifact.probe_sha256, artifact_sha256: fingerprint, probability_calibrated: false, automatic_action: false, candidates };
  } catch { return null; }
}
