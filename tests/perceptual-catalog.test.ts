import { describe, expect, test } from "bun:test";
import {
  CATALOG_REVISION,
  validateCatalogResult,
} from "@/modules/perceptual-duplicates/perceptual-catalog.schemas";

const sample = () => ({
  version: 1,
  revision: CATALOG_REVISION,
  video_id: 2,
  compared_videos: 1,
  skipped_references: 0,
  match_count: 1,
  truncated_matches: false,
  candidate_limited_pairs: 0,
  matches: [
    {
      video_a: 2,
      video_b: 1,
      status: "verified",
      coverage_a: 0.9,
      coverage_b: 0.9,
      segments: [
        {
          a_start: 0,
          a_end: 9,
          b_start: 0,
          b_end: 9,
          speed: 1,
          matched_frames: 8,
          spatial_inliers: 32,
          status: "verified",
          motion: 0.1,
          timing_error_seconds: 0.1,
        },
      ],
    },
  ],
});
const durations = new Map([
  [1, 10],
  [2, 10],
]);

describe("catalogue evidence validation", () => {
  test("accepts bounded evidence for the requested source", () => {
    expect(validateCatalogResult(sample(), 2, durations).matches).toHaveLength(
      1
    );
  });
  test("rejects unrelated sources, impossible counts and inaccurate coverage", () => {
    const unrelated = sample();
    unrelated.video_id = 3;
    const counts = sample();
    counts.compared_videos = 0;
    const coverage = sample();
    coverage.matches[0]!.coverage_a = 1;
    const bounds = sample();
    bounds.matches[0]!.segments[0]!.b_end = 11;
    const ambiguity = sample();
    ambiguity.matches[0]!.segments[0]!.status = "ambiguous";
    for (const value of [unrelated, counts, coverage, bounds, ambiguity]) {
      expect(() => validateCatalogResult(value, 2, durations)).toThrow();
    }
  });
});
