import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRecordingTemporalArtifact, readRecordingTemporalVersions, type RecordingTemporalReadInput } from "@/modules/recordings/recordings.temporal-cache";
import { TEMPORAL_DIAGNOSTIC_SOURCE_SHA256, TEMPORAL_PREFERENCE_RECIPE, TEMPORAL_PREFERENCE_TARGET, TEMPORAL_STATE_PROBE_SHA256 } from "@/modules/recordings/recordings.temporal-preference";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "recording-temporal-cache-")), source = join(root, "source.synthetic"), artifactPath = join(root, "advisory.json");
  await writeFile(source, "synthetic metadata fixture");const info = await stat(source, { bigint: true });
  const proposals = [{ id: "c1", start_seconds: 0, end_seconds: 1200, score: .8 }, { id: "c2", start_seconds: 1200, end_seconds: 1800, score: .6 }];
  const index = { videoId: 42, modelRevision: "siglip2/so400m-patch16-256", storyboardGeneratedAt: new Date("2026-10-10T00:00:00.000Z"), indexedAt: new Date("2026-10-10T00:01:00.000Z"), intervalSeconds: 5, frameCount: 361 };
  const generation = { video_id: 42, analyzed_at: "2026-10-10T00:02:00.000Z", duration: 1800, origin: "synthetic", source_fingerprint: { size_bytes: Number(info.size), mtime_ns: info.mtimeNs.toString(), path_identity_sha256: sha(source) }, index: { model_revision: index.modelRevision, storyboard_generated_at: index.storyboardGeneratedAt.toISOString(), indexed_at: index.indexedAt.toISOString(), interval_seconds: 5, frame_count: 361 }, proposals: proposals.map(p => ({ id: p.id, start: p.start_seconds, end: p.end_seconds, score: p.score })) };
  const entry = { generation_identity: sha(JSON.stringify(generation)), generation_identity_json: JSON.stringify(generation), original_proposal_id: "c1", original: [0, 1200], control: [1020, 1200], candidate: [120, 300], candidate_id: "b".repeat(64), prior_control: { origin: "frozen_prior_C_primary", head_sha256: "e681be589ec7778c7c09b0273a367012c8ba4278989edde41b576b7fe5495d43", receipt_sha256: "c".repeat(64) }, frame_checkpoint_sha256: "d".repeat(64), face_checkpoint_sha256: "e".repeat(64), selector_report_sha256: "f".repeat(64), observed_joint_anchor_count: 2, missing_face_is_unknown: true };
  const artifact = { schema_version: 1, version: "synthetic-advisory-v2", enabled: true, target: TEMPORAL_PREFERENCE_TARGET, scope: "frozen_prior_control_generations_only", selector_recipe: TEMPORAL_PREFERENCE_RECIPE, selector_source_sha256: TEMPORAL_DIAGNOSTIC_SOURCE_SHA256, probe_sha256: TEMPORAL_STATE_PROBE_SHA256, probability_calibrated: false, automatic_action: false, validation: { status: "approved_advisory", answered_pairs: 50, receipt_sha256: "1".repeat(64) }, entries: [entry] };
  let indexReads = 0;
  const input: RecordingTemporalReadInput = { videoId: 42, analyzedAt: generation.analyzed_at, duration: 1800, proposals, source: { path: source, sizeBytes: Number(info.size) }, index: async () => { indexReads++;return index; }, artifactPath };
  return { root, source, artifactPath, artifact, entry, generation, index, input, save: () => writeFile(artifactPath, JSON.stringify(artifact)), indexReads: () => indexReads };
}
describe("dormant exact-generation temporal advisory export", () => {
  it("does no index/source work without an artifact, matching generation, or explicit activation", async () => {
    const f = await fixture();try {
      expect(await readRecordingTemporalVersions(f.input)).toBeNull();expect(f.indexReads()).toBe(0);
      await f.save();expect(await readRecordingTemporalVersions({ ...f.input, analyzedAt: "2026-10-10T00:03:00.000Z" })).toBeNull();expect(f.indexReads()).toBe(0);
      f.artifact.enabled = false;await f.save();expect(await readRecordingTemporalVersions(f.input)).toBeNull();expect(f.indexReads()).toBe(0);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
  it("returns only a separately typed advisory with exact frozen control/candidate provenance", async () => {
    const f = await fixture();try {
      await f.save();const result = await readRecordingTemporalVersions(f.input);
      expect(result?.target).toBe(TEMPORAL_PREFERENCE_TARGET);expect(result?.probability_calibrated).toBe(false);expect(result?.automatic_action).toBe(false);expect(result?.candidates[0]?.range).toEqual([120, 300]);expect(result?.candidates[0]?.control).toEqual([1020, 1200]);expect(result?.candidates[0]?.face_checkpoint_sha256).toBe(f.entry.face_checkpoint_sha256);expect(f.indexReads()).toBe(1);
      expect(JSON.stringify(result)).not.toContain(f.source);expect(JSON.stringify(result)).not.toContain("generation_identity_json");
      result!.candidates[0]!.range[0] = 0;expect((await readRecordingTemporalVersions(f.input))!.candidates[0]!.range).toEqual([120, 300]);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
  it("invalidates every index field, source metadata and the complete immutable proposal universe", async () => {
    const f = await fixture();try {
      await f.save();expect(await readRecordingTemporalVersions(f.input)).not.toBeNull();
      for (const changed of [{ modelRevision: "wrong" }, { storyboardGeneratedAt: new Date(0) }, { indexedAt: new Date(0) }, { intervalSeconds: 10 }, { frameCount: 360 }, { indexedAt: undefined }]) expect(await readRecordingTemporalVersions({ ...f.input, index: async () => ({ ...f.index, ...changed }) })).toBeNull();
      expect(await readRecordingTemporalVersions({ ...f.input, duration: 1801 })).toBeNull();
      for (const proposals of [f.input.proposals.slice(0, 1), [...f.input.proposals].reverse(), f.input.proposals.map(p => ({ ...p, score: .1 })), f.input.proposals.map(p => ({ ...p, end_seconds: p.end_seconds - 1 }))]) expect(await readRecordingTemporalVersions({ ...f.input, proposals })).toBeNull();
      await utimes(f.source, new Date(0), new Date(0));expect(await readRecordingTemporalVersions(f.input)).toBeNull();
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
  it("rejects exploratory promotion, bad pins/checksums, changed duration and out-of-original ranges instead of clamping", async () => {
    const f = await fixture();try {
      expect(parseRecordingTemporalArtifact(f.artifact).entries.length).toBe(1);
      for (const changed of [{ target: "coarse-triage" }, { probability_calibrated: true }, { automatic_action: true }, { probe_sha256: "0".repeat(64) }, { selector_source_sha256: "0".repeat(64) }, { validation: { ...f.artifact.validation, answered_pairs: 49 } }, { validation: { ...f.artifact.validation, status: "exploratory" } }]) expect(() => parseRecordingTemporalArtifact({ ...f.artifact, ...changed })).toThrow();
      for (const changed of [{ generation_identity: "0".repeat(64) }, { candidate: [120, 301] }, { candidate: [-1, 179] }, { candidate: [1020, 1200] }, { control: [0, 1200] }, { original: [0, 1199] }, { prior_control: { ...f.entry.prior_control, head_sha256: "0".repeat(64) } }]) expect(() => parseRecordingTemporalArtifact({ ...f.artifact, entries: [{ ...f.entry, ...changed }] })).toThrow();
      expect(() => parseRecordingTemporalArtifact({ ...f.artifact, entries: [f.entry, f.entry] })).toThrow();
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
  it("invalidates changed cached artifact bytes and refuses oversized/corrupt files without IO work", async () => {
    const f = await fixture();try {
      await f.save();expect(await readRecordingTemporalVersions(f.input)).not.toBeNull();
      f.entry.candidate = [120, 301];await f.save();expect(await readRecordingTemporalVersions(f.input)).toBeNull();
      const reads = f.indexReads();await writeFile(f.artifactPath, " ".repeat(2 * 1024 * 1024 + 1));expect(await readRecordingTemporalVersions(f.input)).toBeNull();expect(f.indexReads()).toBe(reads);
      await writeFile(f.artifactPath, "invalid-json");expect(await readRecordingTemporalVersions(f.input)).toBeNull();expect(f.indexReads()).toBe(reads);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
});
