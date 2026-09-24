import { describe, expect, test } from "bun:test";
import { assessPerceptualMatch } from "@/modules/perceptual-duplicates/perceptual-relevance";
import { engineMatchSchema } from "@/modules/perceptual-duplicates/perceptual-duplicates.schemas";
import type { z } from "zod";

type Match = z.infer<typeof engineMatchSchema>;
function segment(
  a: number,
  end: number,
  b = a,
  status: "verified" | "ambiguous" = "verified"
): Match["segments"][number] {
  return {
    a_start: a,
    a_end: end,
    b_start: b,
    b_end: b + end - a,
    speed: 1,
    matched_frames: 12,
    spatial_inliers: 40,
    status,
    motion: 0.1,
    timing_error_seconds: 0.1,
  };
}
function match(segments: Match["segments"]): Match {
  // Deliberately misleading raw coverage: policy must compute its own evidence.
  return {
    video_a: 1,
    video_b: 2,
    status: "verified",
    coverage_a: 1,
    coverage_b: 1,
    segments,
  };
}

describe("perceptual result relevance", () => {
  test("does not promote a shared intro between long videos", () => {
    const result = assessPerceptualMatch(match([segment(0, 5)]), 7200, 7200);
    expect(result.group).toBe("suppressed");
    expect(result.coverage_a).toBeCloseTo(5 / 7200);
  });
  test("contains a 30 second clip in a two hour live in either direction", () => {
    const forward = match([segment(0, 29, 4000)]);
    expect(assessPerceptualMatch(forward, 30, 7200).classification).toBe(
      "contained_clip"
    );
    const reverse = match([segment(4000, 4029, 0)]);
    const result = assessPerceptualMatch(reverse, 7200, 30);
    expect(result.classification).toBe("contained_clip");
    expect(result.coverage_a).toBeLessThan(0.01);
    expect(result.coverage_b).toBeGreaterThan(0.9);
  });
  test("does not blindly skip clips at the beginning", () => {
    expect(
      assessPerceptualMatch(match([segment(0, 29)]), 30, 7200).classification
    ).toBe("contained_clip");
  });
  test("accepts supported ten-second clips and abstains below the declared scope", () => {
    expect(
      assessPerceptualMatch(match([segment(0, 9, 200)]), 10, 7200)
        .classification
    ).toBe("contained_clip");
    expect(
      assessPerceptualMatch(match([segment(0, 8, 200)]), 9, 7200).group
    ).toBe("suppressed");
  });
  test("requires substantial evidence for overlap, not just a frame threshold", () => {
    expect(assessPerceptualMatch(match([segment(0, 59)]), 600, 600).group).toBe(
      "suppressed"
    );
    expect(
      assessPerceptualMatch(match([segment(0, 65)]), 600, 600).classification
    ).toBe("partial_overlap");
  });
  test("separates partial ambiguous similarity from probable copies", () => {
    const result = assessPerceptualMatch(
      match([segment(11, 24, 48, "ambiguous")]),
      35.333,
      316
    );
    expect(result.classification).toBe("similarity");
    expect(result.group).toBe("similarity");
  });
  test("never counts duplicate intervals twice or fills gaps", () => {
    const result = assessPerceptualMatch(
      match([segment(0, 20), segment(10, 20), segment(80, 99)]),
      100,
      100
    );
    expect(result.matched_seconds_a).toBe(39);
    expect(result.classification).not.toBe("near_duplicate");
  });
  test("does not union conflicting offsets into containment", () => {
    const result = assessPerceptualMatch(
      match([segment(0, 49, 0), segment(50, 99, 500)]),
      100,
      1000
    );
    expect(result.matched_seconds_a).toBe(49);
    expect(result.group).toBe("similarity");
  });
  test("coverage follows each timeline for a speed change", () => {
    const s = { ...segment(0, 29, 200), b_end: 258, speed: 2 };
    const result = assessPerceptualMatch(match([s]), 30, 7200);
    expect(result.classification).toBe("contained_clip");
    expect(result.matched_seconds_a).toBe(29);
    expect(result.matched_seconds_b).toBe(58);
  });
  test("bad bounds or durations cannot create a visible copy", () => {
    expect(assessPerceptualMatch(match([segment(0, 1000)]), 20, 20).group).toBe(
      "suppressed"
    );
    expect(assessPerceptualMatch(match([segment(0, 19)]), NaN, 20).group).toBe(
      "suppressed"
    );
  });
  test("competing locations for the same clip remain review-only", () => {
    const result = assessPerceptualMatch(
      match([segment(0, 29, 100), segment(0, 29, 500)]),
      30,
      7200
    );
    expect(result.group).toBe("similarity");
    expect(result.reasons).toContain("conflicting_alignments");
    expect(result.segment_indices).toEqual([0]);
  });
  test("competing source locations remain review-only when the clip is on side B", () => {
    const result = assessPerceptualMatch(
      match([segment(100, 129, 0), segment(500, 529, 0)]),
      7200,
      30
    );
    expect(result.group).toBe("similarity");
    expect(result.reasons).toContain("conflicting_alignments");
    expect(result.segment_indices).toEqual([0]);
  });
});
