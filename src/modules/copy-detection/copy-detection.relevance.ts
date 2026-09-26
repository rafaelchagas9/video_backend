import type { z } from "zod";
import {
  engineMatchSchema,
  intervalCoverage,
  PERCEPTUAL_ASSESSMENT_REVISION,
  perceptualAssessmentSchema,
} from "./copy-detection.schemas";

export { PERCEPTUAL_ASSESSMENT_REVISION, perceptualAssessmentSchema };
export type PerceptualAssessment = z.infer<typeof perceptualAssessmentSchema>;
type Match = z.infer<typeof engineMatchSchema>;
type Segment = Match["segments"][number];

// Conservative presentation cutoffs, not calibrated probabilities or recall claims.
export const RELEVANCE_POLICY = {
  minimumVideoSeconds: 10,
  nearDuplicateCoverage: 0.9,
  containmentCoverage: 0.85,
  minimumClipEvidenceSeconds: 8,
  minimumOverlapSeconds: 60,
  minimumOverlapCoverage: 0.05,
  minimumSimilaritySeconds: 8,
  minimumSimilarityCoverage: 0.25,
  alignmentToleranceSeconds: 1.5,
} as const;

function coverage(segments: Segment[], a: number, b: number) {
  const ca = intervalCoverage(
    segments.map((s) => [s.a_start, s.a_end]),
    a
  );
  const cb = intervalCoverage(
    segments.map((s) => [s.b_start, s.b_end]),
    b
  );
  return {
    coverage_a: ca,
    coverage_b: cb,
    matched_seconds_a: ca * a,
    matched_seconds_b: cb * b,
  };
}

/** Do not accumulate disjoint hypotheses with incompatible time mappings. */
function strongestAlignment(segments: Segment[], a: number, b: number) {
  let best: Segment[] = [];
  let bestSeconds = 0;
  for (const anchor of segments) {
    const speed =
      (anchor.b_end - anchor.b_start) / (anchor.a_end - anchor.a_start);
    const offset = anchor.b_start - speed * anchor.a_start;
    const aligned = segments.filter(
      (s) =>
        Math.abs(s.b_start - (speed * s.a_start + offset)) <=
          RELEVANCE_POLICY.alignmentToleranceSeconds &&
        Math.abs(s.b_end - (speed * s.a_end + offset)) <=
          RELEVANCE_POLICY.alignmentToleranceSeconds
    );
    const c = coverage(aligned, a, b);
    const seconds = Math.min(c.matched_seconds_a, c.matched_seconds_b);
    if (seconds > bestSeconds) {
      best = aligned;
      bestSeconds = seconds;
    }
  }
  return best;
}

export function assessPerceptualMatch(
  match: Match,
  durationA: number,
  durationB: number
): PerceptualAssessment {
  const empty = {
    coverage_a: 0,
    coverage_b: 0,
    matched_seconds_a: 0,
    matched_seconds_b: 0,
  };
  const result = (
    classification: PerceptualAssessment["classification"],
    group: PerceptualAssessment["group"],
    reasons: string[],
    evidence = empty,
    selected: Segment[] = []
  ): PerceptualAssessment => ({
    revision: PERCEPTUAL_ASSESSMENT_REVISION,
    classification,
    group,
    reasons,
    segment_indices: selected.map((s) => match.segments.indexOf(s)),
    ...evidence,
  });
  if (
    ![durationA, durationB].every(
      (d) => Number.isFinite(d) && d >= RELEVANCE_POLICY.minimumVideoSeconds
    )
  ) {
    return result("insufficient_evidence", "suppressed", [
      "unsupported_duration",
    ]);
  }
  const usable = match.segments.filter(
    (s) =>
      [s.a_start, s.a_end, s.b_start, s.b_end, s.timing_error_seconds].every(
        Number.isFinite
      ) &&
      s.a_start >= 0 &&
      s.b_start >= 0 &&
      s.a_end > s.a_start &&
      s.b_end > s.b_start &&
      s.a_end <= durationA &&
      s.b_end <= durationB &&
      s.timing_error_seconds <= 0.5 &&
      s.matched_frames >= 5
  );
  if (!usable.length)
    return result("insufficient_evidence", "suppressed", [
      "invalid_or_missing_evidence",
    ]);
  const verified = strongestAlignment(
    usable.filter((s) => s.status === "verified"),
    durationA,
    durationB
  );
  const c = coverage(verified, durationA, durationB);
  // A competing mapping of the same query interval is not resolved by choosing
  // whichever hypothesis has slightly more coverage.
  const conflictsOnAxis = (
    other: Segment,
    selected: Segment,
    reverse: boolean
  ) => {
    const coordinates = (segment: Segment) =>
      reverse
        ? ([
            segment.b_start,
            segment.b_end,
            segment.a_start,
            segment.a_end,
          ] as const)
        : ([
            segment.a_start,
            segment.a_end,
            segment.b_start,
            segment.b_end,
          ] as const);
    const x = coordinates(other);
    const y = coordinates(selected);
    const start = Math.max(x[0], y[0]);
    const end = Math.min(x[1], y[1]);
    if (end - start < RELEVANCE_POLICY.minimumClipEvidenceSeconds) return false;
    const time = (start + end) / 2;
    const referenceTime = (p: readonly [number, number, number, number]) =>
      p[2] + ((time - p[0]) * (p[3] - p[2])) / (p[1] - p[0]);
    return (
      Math.abs(referenceTime(x) - referenceTime(y)) >
      2 * RELEVANCE_POLICY.alignmentToleranceSeconds
    );
  };
  const competingAlignment = usable.some((other) =>
    verified.some(
      (selected) =>
        conflictsOnAxis(other, selected, false) ||
        conflictsOnAxis(other, selected, true)
    )
  );
  const shorterCoverage = durationA <= durationB ? c.coverage_a : c.coverage_b;
  const shorterSeconds =
    durationA <= durationB ? c.matched_seconds_a : c.matched_seconds_b;
  if (
    !competingAlignment &&
    Math.min(c.coverage_a, c.coverage_b) >= RELEVANCE_POLICY.nearDuplicateCoverage
  ) {
    return result(
      "near_duplicate",
      "copies",
      ["consistent_sequence", "high_coverage_both"],
      c,
      verified
    );
  }
  if (
    !competingAlignment &&
    shorterCoverage >= RELEVANCE_POLICY.containmentCoverage &&
    shorterSeconds >= RELEVANCE_POLICY.minimumClipEvidenceSeconds
  ) {
    return result(
      "contained_clip",
      "copies",
      ["consistent_sequence", "high_coverage_shorter"],
      c,
      verified
    );
  }
  if (
    !competingAlignment &&
    Math.min(c.coverage_a, c.coverage_b) >= RELEVANCE_POLICY.minimumOverlapCoverage &&
    Math.min(c.matched_seconds_a, c.matched_seconds_b) >=
      RELEVANCE_POLICY.minimumOverlapSeconds
  ) {
    return result(
      "partial_overlap",
      "copies",
      ["consistent_sequence", "substantial_overlap"],
      c,
      verified
    );
  }
  const reviewSegments = strongestAlignment(usable, durationA, durationB);
  const review = coverage(reviewSegments, durationA, durationB);
  const reviewCoverage =
    durationA <= durationB ? review.coverage_a : review.coverage_b;
  const reviewSeconds =
    durationA <= durationB
      ? review.matched_seconds_a
      : review.matched_seconds_b;
  if (
    reviewCoverage >= RELEVANCE_POLICY.minimumSimilarityCoverage &&
    reviewSeconds >= RELEVANCE_POLICY.minimumSimilaritySeconds
  ) {
    return result(
      "similarity",
      "similarity",
      [
        "review_only",
        "copy_not_established",
        ...(reviewSegments.length < usable.length
          ? ["conflicting_alignments"]
          : []),
      ],
      review,
      reviewSegments
    );
  }
  return result(
    "shared_fragment",
    "suppressed",
    ["insufficient_relevance"],
    review,
    reviewSegments
  );
}
