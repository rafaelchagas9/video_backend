import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RECORDING_AUDIO_PIN } from "@/modules/recordings/recordings.audio-cache";
import parity from "./fixtures/recording-model-features.json";
import { RECORDING_FEATURES, assessRecordingModel, parseRecordingModel, recordingHeadScore, recordingModelFeatures, recordingModelReview, recordingAggregateFeatures, RECORDING_AGGREGATES, recordingAudioHeadScore } from "@/modules/recordings/recordings.model";
const vector = (a: number, b = 0) => { const out = new Float32Array(1152); out[0] = a; out[1] = b; return out; };
const row = (id: string, start: number, end: number, score = .8) => ({ id, start_seconds: start, end_seconds: end, score });
const artifact = (passed = true) => parseRecordingModel({ schema_version: 1, version: "fixture-v1", model_revision: "siglip2/so400m-patch16-256", feature_recipe: "recording-v1", features: [...RECORDING_FEATURES], heads: { triage: { weights: [0, 1, ...Array(11).fill(0)], bias: 0, gate_passed: passed } } });

describe("portable recording model", () => {
  it("matches the frozen Python training feature recipe", () => {
    const found = recordingModelFeatures(parity.proposals, parity.duration, { timestamps: parity.timestamps, vectors: parity.vectors.map((vector) => Float32Array.from(vector)) });
    for (let row = 0; row < parity.proposals.length; row++) {
      const features = found.get(parity.proposals[row]!.id)!;
      for (let column = 0; column < RECORDING_FEATURES.length; column++) expect(features[column]).toBeCloseTo(parity.features[row]![column]!, 6);
    }
  });
  it("normalizes stored frames and distinguishes proposal content from its surroundings", () => {
    const rows = [row("c1", 0, 9), row("c2", 10, 19), row("added-1", 0, 100, 1)];
    const features = recordingModelFeatures(rows, 100, { timestamps: [0, 5, 10, 15], vectors: [vector(2), vector(1), vector(0, 3), vector(0, 1)] });
    expect(features.size).toBe(2);
    const a = features.get("c1")!;
    expect(a.slice(0, 6)).toEqual([Math.log(9), .8, 0, 0, .09, .045]);
    expect(a[6]).toBeCloseTo(Math.SQRT1_2, 10);
    expect(a.slice(7)).toEqual([0, 0, 0, 0, 0, 1]);
  });
  it("uses linear percentile interpolation and clips transition distances", () => {
    const features = recordingModelFeatures([row("c1", 0, 20)], 20, { timestamps: [0, 5, 10], vectors: [vector(1), vector(0, 1), vector(-1)] }).get("c1")!;
    expect(features[8]).toBeCloseTo(2 / 3, 10);
    expect(features[9]).toBeCloseTo(1, 10);
    expect(features[10]).toBe(1);
    expect(features[11]).toBe(1);
    expect(features[7]).toBe(1);
  });
  it("has an explicit missing-frame representation and includes the end boundary", () => {
    const features = recordingModelFeatures([row("c1", 0, 5), row("c2", 5, 10)], 10, { timestamps: [10], vectors: [vector(1)] });
    expect(features.get("c1")!.slice(6)).toEqual(Array(7).fill(0));
    expect(features.get("c2")![12]).toBe(1);
  });
  it("applies fitted scaling exactly and only changes order after its evaluation gate", () => {
    const model = artifact();
    model.heads.triage.mean = Array(13).fill(0); model.heads.triage.mean[1] = .5;
    model.heads.triage.scale = Array(13).fill(1); model.heads.triage.scale[1] = 2;
    expect(recordingHeadScore(model.heads.triage, [0, .9, ...Array(11).fill(0)])).toBeCloseTo(.2, 12);
    const rows = [row("c1", 0, 100, .6), row("c2", 110, 120, .9)];
    const empty = { timestamps: [], vectors: [] };
    expect(assessRecordingModel(artifact(true), rows, 120, empty).order).toEqual({ version: "fixture-v1", ids: ["c2", "c1"] });
    const gated = assessRecordingModel(artifact(false), rows, 120, empty);
    expect(gated.order).toEqual({ version: "baseline-v1", ids: ["c1", "c2"] });
    expect(gated.assessment?.applied).toBe(false);
  });
  it("bounds cut suggestions without changing proposals and distinguishes recording potential", () => {
    const model = artifact(false);
    const cut = { schema_version: 1, kind: "cut_offsets", feature_names: [...RECORDING_FEATURES], enabled: true, mean: Array(13).fill(0), scale: Array(13).fill(1), weights: [Array(13).fill(0), Array(13).fill(0)], bias: [.99, -.3], targets: ["start_fraction", "end_fraction"], constraints: { min_seconds: 5 }, fallback: "original_range" };
    const recording = { schema_version: 1, kind: "recording_any_keep", feature_names: [...RECORDING_AGGREGATES], enabled: true, mean: Array(8).fill(0), scale: Array(8).fill(1), weights: Array(8).fill(0), bias: 0, fallback: "no_recording_recommendation", automatic_action: false, label_interpretation: "Triage potential, not final storage worth." };
    const parsed = parseRecordingModel({ ...model, cut, recording_triage: recording });
    const proposals = [row("c1", 2, 5)];
    const result = assessRecordingModel(parsed, proposals, 10, { timestamps: [], vectors: [] });
    expect(result.assessment?.cuts).toEqual([{ id: "c1", start_seconds: 2, end_seconds: 5 }]);
    expect(proposals).toEqual([row("c1", 2, 5)]);
    expect(result.assessment?.recording).toEqual({ target: "triage-potential", score: 0, probability: .5, automatic_action: false });
    const features = recordingModelFeatures([row("c1", 0, 8), row("c2", 5, 10)], 10, { timestamps: [], vectors: [] });
    expect(recordingAggregateFeatures([row("c1", 0, 8), row("c2", 5, 10)], 10, features)![4]).toBe(1);
  });
  it("keeps class probabilities separate from ranking logits", () => {
    const model = artifact(false);
    const parsed = parseRecordingModel({ ...model, heads: { ...model.heads, acceptance: { ...model.heads.triage, weights: Array(13).fill(0), bias: Math.log(3), gate_passed: true } } });
    const result = assessRecordingModel(parsed, [row("c1", 0, 10, .8)], 10, { timestamps: [], vectors: [] });
    expect(result.assessment?.scores[0]?.score).toBe(.8);
    expect(result.assessment?.classifications[0]).toEqual({ id: "c1", target: "triage-potential", probability: .75, source: "numeric" });
    expect(result.order.version).toBe("baseline-v1");
  });
  it("uses validated audio only when present and preserves a numeric fallback per proposal", () => {
    const model = artifact(false), weights = Array(768).fill(0); weights[0] = Math.log(3);
    const head = { weights: Array(13).fill(0), bias: 0, audio_weights: weights, gate_passed: true, model_revision: RECORDING_AUDIO_PIN as typeof RECORDING_AUDIO_PIN };
    const parsed = parseRecordingModel({ ...model, heads: { ...model.heads, acceptance: { ...model.heads.triage, weights: Array(13).fill(0), bias: 0, gate_passed: true }, audio_acceptance: head } });
    const embedding = Array(768).fill(0); embedding[0] = 1;
    const rows = [row("c1", 0, 20), row("c2", 30, 50)];
    const result = assessRecordingModel(parsed, rows, 60, { timestamps: [], vectors: [] }, new Map([["c1", embedding]]));
    expect(result.assessment?.classifications).toEqual([{ id: "c1", target: "triage-potential", probability: .75, source: "audio" }, { id: "c2", target: "triage-potential", probability: .5, source: "numeric" }]);
    expect(result.order.version).toBe("baseline-v1"); expect(rows).toEqual([row("c1", 0, 20), row("c2", 30, 50)]);
    parsed.heads.audio_acceptance!.gate_passed = false;
    expect(assessRecordingModel(parsed, rows, 60, { timestamps: [], vectors: [] }, new Map([["c1", embedding]])).assessment?.classifications[0]?.source).toBe("numeric");
    expect(recordingAudioHeadScore(head, Array(13).fill(0), embedding)).toBeCloseTo(Math.log(3), 12);
    expect(() => recordingAudioHeadScore(head, Array(13).fill(0), Array(767).fill(0))).toThrow();
    expect(() => parseRecordingModel({ ...model, heads: { ...model.heads, audio_acceptance: { ...head, model_revision: "unpinned" } } })).toThrow();
  });
  it("traverses bounded quantile trees and rejects cycles and invalid feature indices", () => {
    const leaf = (value: number) => ({ feature: -2, threshold: -2, left: -1, right: -1, value });
    const cut = { schema_version: 1, kind: "quantile_cut_offsets", feature_names: [...RECORDING_FEATURES], enabled: true, targets: ["start_fraction", "end_fraction"], init_bias: [.1, .9], learning_rate: .05, trees: [[[{ feature: 1, threshold: .8, left: 1, right: 2, value: 0 }, leaf(2), leaf(4)]], [[leaf(-2)]]], constraints: { min_seconds: 5 }, fallback: "original_range" };
    const parsed = parseRecordingModel({ ...artifact(), cut });
    const result = assessRecordingModel(parsed, [row("c1", 0, 100)], 100, { timestamps: [], vectors: [] });
    expect(result.assessment?.cuts).toEqual([{ id: "c1", start_seconds: 20, end_seconds: 80 }]);
    expect(() => parseRecordingModel({ ...artifact(), cut: { ...cut, trees: [[[{ feature: 1, threshold: 0, left: 0, right: 1, value: 0 }, leaf(0)]], []] } })).toThrow();
    expect(() => parseRecordingModel({ ...artifact(), cut: { ...cut, trees: [[[{ feature: 13, threshold: 0, left: 1, right: 2, value: 0 }, leaf(0), leaf(0)]], []] } })).toThrow();
  });
  it("loads stored frames once per analysis identity, and fails back without loading incompatible media", async () => {
    const folder = await mkdtemp(join(tmpdir(), "recording-model-test-")), path = join(folder, "model.json");
    try {
      await writeFile(path, JSON.stringify(artifact()));
      let reads = 0;
      const meta = { videoId: 7, modelRevision: "siglip2/so400m-patch16-256", storyboardGeneratedAt: new Date(0), intervalSeconds: 5, frameCount: 1 };
      const store = { indexed: async () => new Map([[7, meta]]), videoFrames: async () => { reads++; return { timestamps: [0], vectors: [vector(1)] }; } };
      const input = { videoId: 7, analyzedAt: "one", duration: 10, proposals: [row("c1", 0, 10)], modelPath: path, store };
      const first = await recordingModelReview(input), again = await recordingModelReview(input);
      expect(first.order.version).toBe("fixture-v1"); expect(again).toBe(first); expect(reads).toBe(1);
      await recordingModelReview({ ...input, analyzedAt: "two" }); expect(reads).toBe(2);
      meta.modelRevision = "incompatible";
      expect((await recordingModelReview(input)).order.version).toBe("baseline-v1"); expect(reads).toBe(2);
      const absent = await recordingModelReview({ ...input, modelPath: join(folder, "absent.json") });
      expect(absent.assessment).toBeNull(); expect(reads).toBe(2);
    } finally { await rm(folder, { recursive: true, force: true }); }
  });
  it("rejects incompatible feature order, invalid scaling and malformed source features", () => {
    const model = artifact();
    expect(() => parseRecordingModel({ ...model, features: [...model.features].reverse() })).toThrow();
    expect(() => parseRecordingModel({ ...model, heads: { triage: { ...model.heads.triage, mean: Array(13).fill(0) } } })).toThrow();
    expect(() => parseRecordingModel({ ...model, heads: { triage: { ...model.heads.triage, weights: Array(13).fill(Infinity) } } })).toThrow();
    expect(() => recordingModelFeatures([row("c1", 0, 5)], 5, { timestamps: [0, 1], vectors: [new Float32Array(2), new Float32Array(3)] })).toThrow();
    expect(() => recordingModelFeatures([row("c1", 0, 5)], 5, { timestamps: [0, 0], vectors: [vector(1), vector(1)] })).toThrow();
  });
});
