import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { parseWholeReviewHead, recordingWholeInputs, scoreWholeReview, WHOLE_REVIEW_TARGET, WHOLE_FEATURE_RECIPE, WHOLE_REVIEW_FEATURES, WHOLE_VISUAL_RECIPE } from "@/modules/recordings/recordings.whole-preference";
import type { ModelFrames, ModelProposal } from "@/modules/recordings/recordings.model";
const vector = (a: number, b = 0) => { const v = new Float32Array(1152); v[0] = a; v[1] = b; return v; };
const rawHead = () => ({ schema_version: 1, kind: "current_whole_recording_linear", target: WHOLE_REVIEW_TARGET, feature_recipe: WHOLE_FEATURE_RECIPE, feature_names: [...WHOLE_REVIEW_FEATURES], visual_recipe: WHOLE_VISUAL_RECIPE, weights: Array(8).fill(0), visual_weights: Array(1152).fill(0), bias: 0, enabled: false, probability_calibrated: false, automatic_action: false });
const constant: ModelFrames = { timestamps: [0, 5, 10, 15], vectors: [vector(2), vector(2), vector(2), vector(2)] };

describe("isolated full-recording current retention inputs", () => {
  it("uses entire stored frames even when detector proposed no clips", () => {
    const input = recordingWholeInputs([], 20, constant);
    expect(input.features).toEqual([Math.log(20), 0, 0, 0, 0, 0, 0, 1]);
    expect(input.visualMean?.[0]).toBe(1);expect(input.visualMean?.slice(1).every(x => x === 0)).toBe(true);
  });
  it("computes union coverage once and fixed original proposal scores", () => {
    const proposals = [{ id: "a", start_seconds: 0, end_seconds: 10, score: .2 }, { id: "b", start_seconds: 5, end_seconds: 20, score: .6 }, { id: "c", start_seconds: 20, end_seconds: 25, score: .8 }];
    const found = recordingWholeInputs(proposals, 25, { timestamps: [0, 5, 10, 15, 20], vectors: Array.from({ length: 5 }, () => vector(1)) });
    expect(found.features[1]).toBeCloseTo(Math.log1p(3), 12);expect(found.features[2]).toBeCloseTo(1.6 / 3, 12);expect(found.features[3]).toBe(.8);expect(found.features[4]).toBe(1);
  });
  it("normalizes each full frame and measures adjacent whole-sequence transitions", () => {
    const found = recordingWholeInputs([], 10, { timestamps: [0, 5], vectors: [vector(2), vector(0, 3)] });
    expect(found.visualMean?.[0]).toBeCloseTo(1 / Math.sqrt(2), 12);expect(found.visualMean?.[1]).toBeCloseTo(1 / Math.sqrt(2), 12);
    expect(found.features[5]).toBeCloseTo(1 - 1 / Math.sqrt(2), 12);expect(found.features[6]).toBe(1);
  });
  it("ignores manual cuts, decisions, and added proposals rather than teaching from them", () => {
    const originals = [{ id: "a", start_seconds: 0, end_seconds: 20, score: .4 }];
    const annotated = [{ ...originals[0]!, keep: false, verdict: "skip", best: [4, 7], kept_cut: [4, 7] }, { id: "added-manual", start_seconds: 200, end_seconds: 300, score: .99 }];
    const before = JSON.stringify(annotated);
    expect(recordingWholeInputs(annotated, 20, constant)).toEqual(recordingWholeInputs(originals, 20, constant));expect(JSON.stringify(annotated)).toBe(before);
  });
  it("rejects zero/cancelling means, malformed widths and missing full-recording coverage", () => {
    const invalid: Array<[number, ModelFrames]> = [ [10, { timestamps: [0, 5], vectors: [vector(0), vector(1)] }], [10, { timestamps: [0, 5], vectors: [vector(1), vector(-1)] }], [10, { timestamps: [0], vectors: [new Float32Array(1151)] }], [20, { timestamps: [6, 11, 16], vectors: [vector(1), vector(1), vector(1)] }], [30, { timestamps: [0, 15, 20], vectors: [vector(1), vector(1), vector(1)] }], [20, { timestamps: [0, 5], vectors: [vector(1), vector(1)] }], [10, { timestamps: [5, 0], vectors: [vector(1), vector(1)] }], [20, { timestamps: [0, 21], vectors: [vector(1), vector(1)] }] ];
    for (const [duration, frames] of invalid) expect(() => recordingWholeInputs([], duration, frames)).toThrow();
    const overflow = new Float64Array(1152);overflow[0] = 1e200;
    expect(() => recordingWholeInputs([], 10, { timestamps: [0, 5], vectors: [overflow as unknown as Float32Array, vector(1)] })).toThrow();
  });
  it("rejects invented duration, source intervals and malformed original identities", () => {
    for (const duration of [0, -1, Infinity, NaN]) expect(() => recordingWholeInputs([], duration, { timestamps: [], vectors: [] })).toThrow();
    for (const proposals of [[{ id: "a", start_seconds: 0, end_seconds: 20.1, score: .5 }], [{ id: "a", start_seconds: 0, end_seconds: 20, score: Infinity }], [{ id: "a", start_seconds: 0, end_seconds: 10, score: .5 }, { id: "a", start_seconds: 0, end_seconds: 10, score: .5 }]]) expect(() => recordingWholeInputs(proposals, 20, constant)).toThrow();
    expect(() => recordingWholeInputs(Array.from({ length: 61 }, (_, i) => ({ id: `p${i}`, start_seconds: 0, end_seconds: 10, score: .5 })), 20, constant)).toThrow();
  });
  it("preserves raw finite original z scores rather than clamping to probabilities", () => {
    const found = recordingWholeInputs([{ id: "a", start_seconds: 0, end_seconds: 10, score: 2.27 }, { id: "b", start_seconds: 10, end_seconds: 20, score: -.3 }], 20, { timestamps: [], vectors: [] });
    expect(found.features[2]).toBeCloseTo(.985, 12);expect(found.features[3]).toBe(2.27);
    expect(() => recordingWholeInputs([{ id: "a", start_seconds: 0, end_seconds: 10, score: 1.7e308 }, { id: "b", start_seconds: 10, end_seconds: 20, score: 1.7e308 }], 20, { timestamps: [], vectors: [] })).toThrow();
  });
  it("requires a complete visual input for visual heads, while diagnostic enabled flags do not act", () => {
    const input = recordingWholeInputs([], 20, { timestamps: [], vectors: [] });expect(input.visualMean).toBeNull();expect(input.features[7]).toBe(0);
    const raw = rawHead();raw.weights[0] = 2;raw.bias = .3;
    expect(scoreWholeReview(parseWholeReviewHead(raw), input)).toBeCloseTo(2 * Math.log(20) + .3, 12);
    raw.visual_weights[0] = 1;expect(() => scoreWholeReview(parseWholeReviewHead(raw), input)).toThrow();
    expect(parseWholeReviewHead({ ...rawHead(), enabled: true }).enabled).toBe(true);
  });
  it("strictly checks the explicit whole target, recipe, dimensions and finite head schema", () => {
    for (const changed of [{ schema_version: true }, { schema_version: 2 }, { enabled: 1 }, { enabled: undefined }, { target: "clip_acceptance" }, { feature_recipe: "recording-v1" }, { feature_names: [...WHOLE_REVIEW_FEATURES].reverse() }, { visual_recipe: "proposal_mean" }, { weights: Array(7).fill(0) }, { weights: [true, ...Array(7).fill(0)] }, { visual_weights: [false, ...Array(1151).fill(0)] }, { bias: Infinity }, { probability_calibrated: true }, { automatic_action: true }, { unexpected: 0 }]) expect(() => parseWholeReviewHead({ ...rawHead(), ...changed })).toThrow();
    const found = recordingWholeInputs([], 20, constant);expect(() => scoreWholeReview(parseWholeReviewHead(rawHead()), { ...found, features: [true, ...found.features.slice(1)] as unknown as number[] })).toThrow();
  });
  it("matches two independently computed Python numeric fixtures", () => {
    const fixture = JSON.parse(readFileSync(new URL("../vision-lab/model_completion/fixtures/whole_review_parity.json", import.meta.url), "utf8")) as { synthetic_only: boolean; head: unknown; cases: Array<{ inputs: { proposals: Array<{ id: string; start: number; end: number; score: number }>; duration_seconds: number; timestamps: number[]; vectors: number[][] }; expected: { features: number[]; visual_mean: number[]; score: number } }> };
    expect(fixture.synthetic_only).toBe(true);expect(fixture.cases.length).toBe(2);
    for (const c of fixture.cases) {
      const proposals: ModelProposal[] = c.inputs.proposals.map(p => ({ id: p.id, start_seconds: p.start, end_seconds: p.end, score: p.score }));
      const found = recordingWholeInputs(proposals, c.inputs.duration_seconds, { timestamps: c.inputs.timestamps, vectors: c.inputs.vectors.map(v => Float32Array.from(v)) });
      found.features.forEach((x, i) => expect(x).toBeCloseTo(c.expected.features[i]!, 12));found.visualMean!.forEach((x, i) => expect(x).toBeCloseTo(c.expected.visual_mean[i]!, 12));expect(scoreWholeReview(parseWholeReviewHead(fixture.head), found)).toBeCloseTo(c.expected.score, 12);
    }
  });
});
