import { z } from "zod";

export const perceptualDuplicatesJobIdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export const startPerceptualDuplicatesBodySchema = z
  .object({
    video_ids: z
      .array(z.number().int().positive())
      .min(2)
      .max(12)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: "video_ids must not contain duplicates",
      }),
  })
  .strict();

export const perceptualDuplicatesJobPayloadSchema = z
  .object({
    version: z.literal(2),
    generation: z.string().min(1).max(128),
    userId: z.number().int().positive(),
    videoIds: z.array(z.number().int().positive()).min(2).max(12),
    requestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();

export const legacyPerceptualDuplicatesJobPayloadSchema = z
  .object({
    version: z.literal(1),
    userId: z.number().int().positive(),
    videoIds: z.array(z.number().int().positive()).min(2).max(12),
    requestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();

const engineVideoSchema = z
  .object({
    id: z.number().int().positive(),
    frame_count: z.number().int().nonnegative(),
    duration_seconds: z
      .number()
      .finite()
      .min(5)
      .max(24 * 60 * 60),
    sampled_frames: z.number().int().nonnegative().optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
  })
  .strip();

const engineSegmentSchema = z
  .object({
    a_start: z.number().finite().nonnegative(),
    a_end: z.number().finite().positive(),
    b_start: z.number().finite().nonnegative(),
    b_end: z.number().finite().positive(),
    speed: z.number().finite().positive().max(16),
    matched_frames: z.number().int().positive(),
    spatial_inliers: z.number().int().nonnegative(),
    status: z.enum(["verified", "ambiguous"]),
    motion: z.number().finite().min(0).max(1),
    timing_error_seconds: z.number().finite().nonnegative(),
    temporal_motion_similarity: z.number().finite().min(-1).max(1).optional(),
    temporal_motion_energy: z.number().finite().min(0).max(1).optional(),
    temporal_motion_overlap: z.number().finite().min(0).max(1).optional(),
    temporal_motion_grid_cells: z.number().int().min(0).max(16).optional(),
    temporal_motion_grid_rows: z.number().int().min(0).max(4).optional(),
    temporal_motion_grid_columns: z.number().int().min(0).max(4).optional(),
    temporal_motion_span_x: z.number().finite().min(0).max(1).optional(),
    temporal_motion_span_y: z.number().finite().min(0).max(1).optional(),
    temporal_informative_transitions: z.number().int().nonnegative().optional(),
    transform_deviation: z.number().finite().nonnegative().optional(),
  })
  .strict()
  .refine(
    (segment) =>
      segment.a_end > segment.a_start && segment.b_end > segment.b_start,
    { message: "Invalid perceptual duplicate segment" }
  );

export const engineMatchSchema = z
  .object({
    video_a: z.number().int().positive(),
    video_b: z.number().int().positive(),
    status: z.enum(["verified", "ambiguous"]),
    segments: z.array(engineSegmentSchema).min(1).max(4096),
    coverage_a: z.number().finite().min(0).max(1),
    coverage_b: z.number().finite().min(0).max(1),
  })
  .strict()
  .refine((match) => match.video_a !== match.video_b, {
    message: "A video cannot match itself",
  });

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

export const perceptualDuplicatesEngineResultSchema = z
  .object({
    version: z.literal(1),
    revision: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._:+-]+$/),
    videos: z.array(engineVideoSchema).min(2).max(12),
    matches: z.array(engineMatchSchema).max(66),
    runtime: z
      .object({
        inference_provider: z.literal("MIGraphXExecutionProvider"),
        onnxruntime: z.string().regex(/^[A-Za-z0-9.+-]{1,64}$/),
        precision: z.literal("fp32"),
        decode: z.literal("vaapi"),
        model_sha256: z.string().regex(/^[a-f0-9]{64}$/),
        initialization_seconds: z.number().finite().nonnegative(),
        elapsed_seconds: z.number().finite().nonnegative(),
        sample_rate: z.number().finite().positive(),
        verification_rate: z.number().finite().positive(),
        candidate_limit_per_pair: z.number().int().positive().max(1024),
        candidate_limited_pairs: z.number().int().nonnegative(),
        verification_limited_pairs: z.number().int().nonnegative().optional(),
        retrieval_truncated: z.boolean().optional(),
        retrieval_candidates: z.number().int().nonnegative().optional(),
        cache_bytes: z.number().int().nonnegative().optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((result, context) => {
    const ids = result.videos.map((video) => video.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        message: "Duplicate result video id",
      });
    }
    const durations = new Map(
      result.videos.map((video) => [video.id, video.duration_seconds])
    );
    const known = new Set(ids);
    const pairs = new Set<string>();
    let segmentCount = 0;
    for (const match of result.matches) {
      if (!known.has(match.video_a) || !known.has(match.video_b)) {
        context.addIssue({
          code: "custom",
          message: "Match references an unknown video",
        });
      }
      const durationA = durations.get(match.video_a);
      const durationB = durations.get(match.video_b);
      if (durationA !== undefined && durationB !== undefined) {
        if (
          match.segments.some(
            (segment) => segment.a_end > durationA || segment.b_end > durationB
          )
        ) {
          context.addIssue({
            code: "custom",
            path: ["matches"],
            message: "Match segment exceeds its referenced video duration",
          });
        }
        const expectedStatus = match.segments.some(
          (segment) => segment.status === "ambiguous"
        )
          ? "ambiguous"
          : "verified";
        if (match.status !== expectedStatus) {
          context.addIssue({
            code: "custom",
            path: ["matches"],
            message: "Match status does not agree with its segments",
          });
        }
        const coverageA = intervalCoverage(
          match.segments.map((segment) => [segment.a_start, segment.a_end]),
          durationA
        );
        const coverageB = intervalCoverage(
          match.segments.map((segment) => [segment.b_start, segment.b_end]),
          durationB
        );
        if (
          Math.abs(match.coverage_a - coverageA) > 1e-6 ||
          Math.abs(match.coverage_b - coverageB) > 1e-6
        ) {
          context.addIssue({
            code: "custom",
            path: ["matches"],
            message: "Match coverage does not agree with its segment union",
          });
        }
      }
      const pair = [match.video_a, match.video_b]
        .sort((a, b) => a - b)
        .join(":");
      if (pairs.has(pair)) {
        context.addIssue({
          code: "custom",
          message: "Duplicate result video pair",
        });
      }
      pairs.add(pair);
      segmentCount += match.segments.length;
    }
    if (segmentCount > 8192) {
      context.addIssue({ code: "custom", message: "Too many result segments" });
    }
  });

export const perceptualDuplicatesCheckpointSchema = z
  .object({
    stage: z.enum(["preparing", "comparing", "completed"]),
    completedUnits: z.number().int().nonnegative(),
    totalUnits: z.number().int().positive(),
    data: z
      .object({
        result: perceptualDuplicatesEngineResultSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const perceptualDuplicatesPublicJobSchema = z.object({
  id: z.number().int().positive(),
  video_ids: z.array(z.number().int().positive()).min(2).max(12),
  status: z.enum([
    "queued",
    "running",
    "retry_wait",
    "completed",
    "failed",
    "cancelled",
  ]),
  phase: z.enum([
    "queued",
    "preparing",
    "comparing",
    "completed",
    "failed",
    "cancelled",
  ]),
  progress: z.object({
    completed_units: z.number().int().nonnegative(),
    total_units: z.number().int().positive(),
  }),
  result: perceptualDuplicatesEngineResultSchema.nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  retry_count: z.number().int().nonnegative(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  started_at: z.string().datetime().nullable(),
  completed_at: z.string().datetime().nullable(),
  cancelled_at: z.string().datetime().nullable(),
});

export const perceptualDuplicatesJobResponseSchema = z.object({
  success: z.literal(true),
  data: perceptualDuplicatesPublicJobSchema,
});

export const perceptualDuplicatesStartedResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.object({
      job: perceptualDuplicatesPublicJobSchema,
      reused: z.boolean(),
    }),
    message: z.string(),
  })
  .meta({
    headers: {
      Location: {
        description: "Canonical URL of the accepted comparison job",
        type: "string",
      },
    },
  });

export type PerceptualDuplicatesEngineResult = z.infer<
  typeof perceptualDuplicatesEngineResultSchema
>;
export type PerceptualDuplicatesJobPayload = z.infer<
  typeof perceptualDuplicatesJobPayloadSchema
>;
export type PerceptualDuplicatesCheckpoint = z.infer<
  typeof perceptualDuplicatesCheckpointSchema
>;
