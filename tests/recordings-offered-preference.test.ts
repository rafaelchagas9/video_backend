import { describe, expect, it } from "bun:test";
import { parseOfferedPreferenceHead, offeredPreferenceFeatures, scoreOfferedPreference, type OfferedVersionInput } from "@/modules/recordings/recordings.offered-preference";
const vector = (a: number, b = 0) => { const v = new Float32Array(1152); v[0] = a; v[1] = b; return v; };
const head = () => ({ schema_version: 1, kind: "offered_version_preference_linear", numeric_weights: Array(13).fill(0), visual_weights: Array(1152).fill(0), duration_weights: [0, 0], bias: 0, soft_preferred_seconds: [180, 900], duration_recipe: "log_hinges_180_900_v1", feature_recipe: "recording-v1-replace_exact_offered_proposal", visual_recipe: "unit_mean_unit_frames_inside_exact_offered_range", target: "preferred_version_if_keep_one", probability_calibrated: false, automatic_action: false });
const input = (): OfferedVersionInput => ({ originalProposalId: "c1", proposals: [{ id: "c1", start_seconds: 10, end_seconds: 110, score: .8 }, { id: "c2", start_seconds: 120, end_seconds: 180, score: .6 }], recordingDuration: 200, offeredRange: [20, 50], frames: { timestamps: [10, 20, 30, 50, 120, 160], vectors: [vector(0, -1), vector(2), vector(0, 3), vector(0, 5), vector(1), vector(1)] } });

describe("standalone exact offered-version preference", () => {
  it("strictly rejects wrong targets, recipes, dimensions, calibration and automatic actions", () => {
    expect(parseOfferedPreferenceHead(head()).target).toBe("preferred_version_if_keep_one");
    for (const changed of [{ kind: "cut_offsets" }, { target: "whole_recording" }, { numeric_weights: Array(12).fill(0) }, { visual_weights: Array(1151).fill(0) }, { duration_weights: [0] }, { bias: Infinity }, { probability_calibrated: true }, { automatic_action: true }, { soft_preferred_seconds: [180, 901] }, { duration_recipe: "duration_cap" }, { duration_recipe: undefined }, { visual_recipe: "original_mean" }, { feature_recipe: "recording-v1" }, { enabled: true }]) expect(() => parseOfferedPreferenceHead({ ...head(), ...changed })).toThrow();
  });
  it("replaces only the identified original range and preserves its score and surroundings", () => {
    const source = input(); const before = JSON.stringify(source.proposals); const found = offeredPreferenceFeatures(source);
    const expected = [Math.log(30), .8, (Math.log(30) - Math.log(60)) / 2, .1, .15, .175];
    expected.forEach((value, i) => expect(found.numeric[i]).toBeCloseTo(value, 10));
    expect(found.numeric.length).toBe(13);expect(found.numeric[12]).toBe(1);
    expect(JSON.stringify(source.proposals)).toBe(before);expect(source.offeredRange).toEqual([20, 50]);
    expect(() => offeredPreferenceFeatures({ ...source, originalProposalId: "missing" })).toThrow();
    expect(() => offeredPreferenceFeatures({ ...source, offeredRange: [0, 50] })).toThrow();
    expect(() => offeredPreferenceFeatures({ ...source, offeredRange: [20, 111] })).toThrow();
    expect(() => offeredPreferenceFeatures({ ...source, proposals: [...source.proposals, source.proposals[0]!] })).toThrow();
  });
  it("pools normalized inclusive in-range frames rather than the original or raw-magnitude mean", () => {
    const visual = offeredPreferenceFeatures(input()).visual;
    expect(visual[0]).toBeCloseTo(1 / Math.sqrt(5), 10);expect(visual[1]).toBeCloseTo(2 / Math.sqrt(5), 10);
    expect(visual.slice(2).every((value) => value === 0)).toBe(true);
    expect(Math.sqrt(visual.reduce((sum, value) => sum + value * value, 0))).toBeCloseTo(1, 10);
  });
  it("keeps duration preference soft with zero hinges inside 3–15 minutes and no cap", () => {
    const long = (seconds: number): OfferedVersionInput => ({ originalProposalId: "c1", proposals: [{ id: "c1", start_seconds: 0, end_seconds: 2400, score: .8 }], recordingDuration: 2400, offeredRange: [0, seconds], frames: { timestamps: [0, 10], vectors: [vector(1), vector(1)] } });
    expect(offeredPreferenceFeatures(long(60)).duration).toEqual([Math.log(3), 0]);
    for (const seconds of [180, 300, 900]) expect(offeredPreferenceFeatures(long(seconds)).duration).toEqual([0, 0]);
    expect(offeredPreferenceFeatures(long(1800)).duration).toEqual([0, Math.log(2)]);
    const model = head();model.duration_weights = [-1, -2];expect(scoreOfferedPreference(model, long(1800))).toBeCloseTo(-2 * Math.log(2), 10);
  });
  it("fails closed for unsupported, zero, cancelling or malformed frame support", () => {
    const source = input();
    for (const frames of [ { timestamps: [], vectors: [] }, { timestamps: [10], vectors: [vector(1)] }, { timestamps: [20], vectors: [vector(0)] }, { timestamps: [20, 30], vectors: [vector(1), vector(-1)] }, { timestamps: [30, 20], vectors: [vector(1), vector(1)] }, { timestamps: [20], vectors: [new Float32Array(2)] }, { timestamps: [20], vectors: [vector(Infinity)] }, { timestamps: [201], vectors: [vector(1)] } ]) expect(() => offeredPreferenceFeatures({ ...source, frames })).toThrow();
    expect(() => offeredPreferenceFeatures({ ...source, frames: { timestamps: Array.from({ length: 8001 }, (_, i) => i / 100), vectors: Array.from({ length: 8001 }, () => vector(1)) } })).toThrow();
  });
  it("exports only a finite relative score, without applying probability or altering ranges", () => {
    const model = head();model.numeric_weights[1] = 2;model.visual_weights[0] = 3;model.duration_weights[0] = -.5;model.bias = 4;
    expect(scoreOfferedPreference(model, input())).toBeCloseTo(4 + 1.6 + 3 / Math.sqrt(5) - .5 * Math.log(6), 10);
    expect(() => offeredPreferenceFeatures({ originalProposalId: "c1", proposals: [{ id: "c1", start_seconds: 0, end_seconds: 1, score: .8 }], recordingDuration: 1, offeredRange: [0, Number.MIN_VALUE], frames: { timestamps: [0], vectors: [vector(1)] } })).toThrow();
    const overflow = head();overflow.numeric_weights[0] = Number.MAX_VALUE;
    expect(() => scoreOfferedPreference(overflow, input())).toThrow();
  });
});
