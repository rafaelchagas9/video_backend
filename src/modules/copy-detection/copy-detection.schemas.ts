import { z } from "zod";

/** Engine generation; results of other revisions are never shown as current evidence. */
export const COPY_DETECTION_REVISION = "audio-visual-v1";

/** Presentation policy, deliberately independent of the extraction/cache revision. */
export const PERCEPTUAL_ASSESSMENT_REVISION = "relevance-v1";
export const perceptualAssessmentSchema = z.object({
  revision: z.literal(PERCEPTUAL_ASSESSMENT_REVISION),
  classification: z.enum([
    "near_duplicate",
    "contained_clip",
    "partial_overlap",
    "similarity",
    "shared_fragment",
    "insufficient_evidence",
  ]),
  group: z.enum(["copies", "similarity", "suppressed"]),
  reasons: z.array(z.string()),
  segment_indices: z.array(z.number().int().nonnegative()),
  coverage_a: z.number().finite().min(0).max(1),
  coverage_b: z.number().finite().min(0).max(1),
  matched_seconds_a: z.number().finite().nonnegative(),
  matched_seconds_b: z.number().finite().nonnegative(),
});

const matchSegmentSchema = z
  .object({
    a_start: z.number().finite().nonnegative(),
    a_end: z.number().finite().positive(),
    b_start: z.number().finite().nonnegative(),
    b_end: z.number().finite().positive(),
    speed: z.number().finite().positive().max(16),
    /** Aligned audio fingerprint items (~8 per second). */
    matched_frames: z.number().int().positive(),
    /** Median SIFT inliers of the visual samples, 0 when not verified visually. */
    spatial_inliers: z.number().int().nonnegative(),
    status: z.enum(["verified", "ambiguous"]),
    motion: z.number().finite().min(0).max(1),
    timing_error_seconds: z.number().finite().nonnegative(),
    temporal_motion_similarity: z.number().finite().min(-1).max(1).optional(),
  })
  .strict()
  .refine((s) => s.a_end > s.a_start && s.b_end > s.b_start, {
    message: "Invalid copy segment",
  });

export const engineMatchSchema = z
  .object({
    video_a: z.number().int().positive(),
    video_b: z.number().int().positive(),
    status: z.enum(["verified", "ambiguous"]),
    segments: z.array(matchSegmentSchema).min(1).max(4096),
    coverage_a: z.number().finite().min(0).max(1),
    coverage_b: z.number().finite().min(0).max(1),
  })
  .strict()
  .refine((match) => match.video_a !== match.video_b, {
    message: "A video cannot match itself",
  });
export type CopyMatch = z.infer<typeof engineMatchSchema>;

export function intervalCoverage(
  intervals: Array<readonly [number, number]>,
  duration: number
): number {
  if (intervals.length === 0) return 0;
  const sorted = [...intervals].sort((left, right) => left[0] - right[0]);
  let covered = 0;
  let start = sorted[0]![0];
  let end = sorted[0]![1];
  for (const [nextStart, nextEnd] of sorted.slice(1)) {
    if (nextStart <= end) {
      end = Math.max(end, nextEnd);
    } else {
      covered += end - start;
      start = nextStart;
      end = nextEnd;
    }
  }
  return Math.min(1, (covered + end - start) / duration);
}

/** One video's matches, in the shape the Kura synchronization screens consume. */
export const copyDetectionResultSchema = z
  .object({
    version: z.literal(1),
    revision: z.literal(COPY_DETECTION_REVISION),
    video_id: z.number().int().positive(),
    compared_videos: z.number().int().nonnegative(),
    retrieval_references: z.number().int().nonnegative().optional(),
    retrieval_candidates: z.number().int().nonnegative().optional(),
    retrieval_truncated: z.boolean().optional(),
    skipped_references: z.number().int().nonnegative(),
    match_count: z.number().int().nonnegative(),
    matches: z
      .array(engineMatchSchema.safeExtend({ assessment: perceptualAssessmentSchema }))
      .max(50),
    truncated_matches: z.boolean(),
    candidate_limited_pairs: z.number().int().nonnegative(),
  })
  .strict();

export const copyDetectionResultsSchema = z.object({
  items: z.array(copyDetectionResultSchema),
  assessment_revision: z.string(),
  diagnostics: z.object({
    candidate_limited_pairs: z.number().int().nonnegative(),
    truncated_videos: z.number().int().nonnegative(),
    suppressed_matches: z.number().int().nonnegative(),
    retrieval_limited_videos: z.number().int().nonnegative().optional(),
  }),
  video_labels: z.record(z.string(), z.string()).optional(),
  total: z.number().int().nonnegative(),
  limit: z.number().int(),
  offset: z.number().int(),
});
export type CopyDetectionResults = z.infer<typeof copyDetectionResultsSchema>;
