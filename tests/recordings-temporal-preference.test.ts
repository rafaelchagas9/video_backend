import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { proposeTemporalPreference, TEMPORAL_DIAGNOSTIC_SOURCE_SHA256, TEMPORAL_PREFERENCE_RECIPE, TEMPORAL_PREFERENCE_TARGET, TEMPORAL_STATE_PROBE_SHA256, type TemporalPreferenceInput, type TemporalPreferenceResult } from "@/modules/recordings/recordings.temporal-preference";

const generation = "a".repeat(64);
const fixture = JSON.parse(readFileSync(new URL("./fixtures/recordings-temporal-preference.json", import.meta.url), "utf8")) as {
  synthetic_only: boolean; python_source_sha256: string; recipe: string;
  cases: Array<{ name: string; input: Pick<TemporalPreferenceInput, "timestamps" | "probabilities" | "faces" | "original" | "control">; expected: Record<string, unknown> }>;
};
function input(index = 0): TemporalPreferenceInput {
  return { ...structuredClone(fixture.cases[index]!.input), generationIdentity: generation, stateGenerationIdentity: generation, faceGenerationIdentity: generation, probeSha256: TEMPORAL_STATE_PROBE_SHA256 };
}
/** Compare every Python field, including absence of candidate-only fields, with float reduction tolerance. */
function parity(actual: unknown, expected: unknown, path = ""): void {
  if (typeof expected === "number") {
    expect(typeof actual).toBe("number");
    expect(Math.abs((actual as number) - expected)).toBeLessThanOrEqual(1e-10 + Math.abs(expected) * 1e-12);
  } else if (Array.isArray(expected)) {
    expect(Array.isArray(actual)).toBe(true);expect((actual as unknown[]).length).toBe(expected.length);
    expected.forEach((value, i) => parity((actual as unknown[])[i], value, `${path}[${i}]`));
  } else if (expected && typeof expected === "object") {
    expect(actual !== null && typeof actual === "object").toBe(true);
    for (const [key, value] of Object.entries(expected)) parity((actual as Record<string, unknown>)[key], value, `${path}.${key}`);
  } else expect(actual).toBe(expected);
}
function byName(name: string): TemporalPreferenceResult {
  const index = fixture.cases.findIndex(c => c.name === name);
  expect(index).toBeGreaterThanOrEqual(0);
  return proposeTemporalPreference(input(index));
}

describe("isolated sampled temporal same-duration challenger", () => {
  it("matches every field of 23 synthetic goldens from the pinned Python numeric recipe", () => {
    expect(fixture.synthetic_only).toBe(true);expect(fixture.python_source_sha256).toBe(TEMPORAL_DIAGNOSTIC_SOURCE_SHA256);expect(fixture.recipe).toBe(TEMPORAL_PREFERENCE_RECIPE);expect(fixture.cases.length).toBe(23);
    for (let i = 0; i < fixture.cases.length; i++) {
      const found = proposeTemporalPreference(input(i));parity(found, fixture.cases[i]!.expected);
      expect(found.target).toBe(TEMPORAL_PREFERENCE_TARGET);expect(found.probability_calibrated).toBe(false);expect(found.automatic_action).toBe(false);
      expect(found.generation_identity).toBe(generation);expect(found.probe_sha256).toBe(TEMPORAL_STATE_PROBE_SHA256);
      if (!found.candidate_range) for (const field of ["retained_omitted_joint_points", "coverage_candidate", "control_iou", "action_proxy_point_mass"]) expect(field in found).toBe(false);
    }
  });
  it("reproduces ties-to-even and a grid relative to the actual fractional original start", () => {
    expect(byName("round_positive_even_half_grid").candidate_range).toEqual([120, 300]);
    expect(byName("round_positive_odd_half_grid").candidate_range).toEqual([130, 310]);
    expect(byName("grid_relative_to_fractional_original").candidate_range).toEqual([122.5, 302.5]);
  });
  it("preserves exact duration through both edge clamps and permits controls longer than 15m", () => {
    expect(byName("clip_at_original_start").candidate_range).toEqual([0, 180]);expect(byName("clip_at_original_end").candidate_range).toEqual([1020, 1200]);
    const long = byName("control_duration_over_15_minutes");expect(long.candidate_range![1] - long.candidate_range![0]).toBe(1200);
    expect(long.candidate_range![0]).toBeGreaterThanOrEqual(long.original_range[0]);expect(long.candidate_range![1]).toBeLessThanOrEqual(long.original_range[1]);
  });
  it("reports observed negative and unobserved points separately, without interpolated face/action truth", () => {
    const missing = byName("missing_faces_are_unknown"), negative = byName("observed_negative_face"), one = byName("single_joint_anchor_is_diagnostic_insufficiency");
    expect(missing.coverage_original.observed_face_points).toBe(0);expect(missing.coverage_original.face_unknown_frame_points).toBe(241);
    expect(negative.coverage_original.observed_face_points).toBe(2);expect(negative.coverage_original.face_unknown_frame_points).toBe(239);expect(negative.candidate_range).toBeNull();
    expect(one.status).toBe("single_observed_joint_anchor_insufficient");expect(one.single_anchor_is_not_user_minimum).toBe(true);
    const challenger = byName("relocated_omitted_episode");expect(challenger.coverage_candidate!.continuous_face_coverage_known).toBe(false);expect(challenger.action_proxy_point_mass!.human_action_truth).toBe(false);expect(challenger.action_proxy_point_mass!.elapsed_time_coverage).toBe(false);
  });
  it("requires exact pinned state and face generation identities before selecting", () => {
    for (const changed of [{ generationIdentity: "video-123" }, { generationIdentity: "b".repeat(64) }, { stateGenerationIdentity: "b".repeat(64) }, { faceGenerationIdentity: "b".repeat(64) }, { probeSha256: "b".repeat(64) }]) expect(() => proposeTemporalPreference({ ...input(), ...changed })).toThrow();
  });
  it("rejects unsupported timeline geometry and nonfinite or malformed state simplexes", () => {
    const mutations: Array<(source: TemporalPreferenceInput) => void> = [
      source => { source.timestamps = []; source.probabilities = []; },
      source => { source.timestamps = [0, 0]; source.probabilities = [[.2, 0, 0, .8], [.2, 0, 0, .8]]; },
      source => { source.timestamps = [-1, 5]; source.probabilities = [[.2, 0, 0, .8], [.2, 0, 0, .8]]; },
      source => { source.timestamps = [NaN]; source.probabilities = [[.2, 0, 0, .8]]; },
      source => { source.probabilities = []; },
      source => { source.probabilities = source.probabilities.map(() => [.2, 0, .8]); },
      source => { source.probabilities = source.probabilities.map(() => [.2, 0, 0, .8, 0]); },
      source => { source.probabilities = source.probabilities.map(() => [.3, 0, 0, .8]); },
      source => { source.probabilities = source.probabilities.map(() => [NaN, 0, 0, .8]); },
      source => { source.probabilities = source.probabilities.map(() => [-.1, 0, 0, 1.1]); },
      source => { source.timestamps = Array.from({ length: 8001 }, (_, i) => i * 5); source.probabilities = Array.from({ length: 8001 }, () => [.2, 0, 0, .8]); },
    ];
    for (const mutate of mutations) { const source = input();mutate(source);expect(() => proposeTemporalPreference(source)).toThrow(); }
  });
  it("rejects duplicate/stale observed points, invalid confidence and illegal original/control bounds", () => {
    const face = input().faces[0]!;
    for (const faces of [[face, face], [{ ...face, index: 40.5 }], [{ ...face, index: -1 }], [{ ...face, index: 241 }], [{ ...face, timestamp: face.timestamp + .001 }], [{ ...face, max_confidence: Infinity }], [{ ...face, max_confidence: -1 }], [{ ...face, max_confidence: 1.01 }]]) expect(() => proposeTemporalPreference({ ...input(), faces })).toThrow();
    expect(() => proposeTemporalPreference({ ...input(), faces: [{ ...face, detected: "yes" } as unknown as typeof face] })).toThrow();
    for (const control of [[-1, 179], [1100, 1201], [1020, 1199], [1200, 1020], [1020, Infinity]]) expect(() => proposeTemporalPreference({ ...input(), control: control as [number, number] })).toThrow();
    expect(() => proposeTemporalPreference({ ...input(), original: [500, 1000] })).toThrow();
  });
  it("does not mutate frozen receipts and accepts stored typed numeric state arrays", () => {
    const source = input(), before = JSON.stringify(source);
    Object.freeze(source.original);Object.freeze(source.control);Object.freeze(source.faces);source.faces.forEach(Object.freeze);
    Object.freeze(source.timestamps);Object.freeze(source.probabilities);source.probabilities.forEach(Object.freeze);
    const result = proposeTemporalPreference(source);expect(JSON.stringify(source)).toBe(before);expect(result.candidate_range).toEqual([120, 300]);
    const typed = { ...input(), timestamps: Float64Array.from(input().timestamps), probabilities: input().probabilities.map(row => Float32Array.from(row)) };
    expect(proposeTemporalPreference(typed).candidate_range).toEqual(result.candidate_range);
  });
});
