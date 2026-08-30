import { z } from "zod";
import { SYSTEM_BOOKMARK_CATEGORY_KEYS } from "@/modules/bookmarks/bookmark-categories.constants";

export const contentAnalysisProfileSchema = z.enum([
  "fast",
  "balanced",
  "thorough",
]);
export const nudityCategorySchema = z.enum(SYSTEM_BOOKMARK_CATEGORY_KEYS);

export const contentAnalysisIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export const startNudityAnalysisBodySchema = z
  .object({
    profile: contentAnalysisProfileSchema.default("balanced"),
    categories: z
      .array(nudityCategorySchema)
      .min(1)
      .refine((categories) => new Set(categories).size === categories.length, {
        message: "categories must not contain duplicates",
      })
      .optional(),
    force: z.boolean().default(false),
  })
  .strict();

export const contentAnalysisIdempotencyHeadersSchema = z.object({
  "idempotency-key": z.string().trim().min(1).max(255).optional(),
});

export const contentAnalysisPublicRunSchema = z.object({
  id: z.number().int().positive(),
  video_id: z.number().int().positive(),
  kind: z.literal("nudity"),
  profile: contentAnalysisProfileSchema,
  requested_categories: z.array(nudityCategorySchema),
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
    "extracting",
    "analyzing",
    "refining",
    "condensing",
    "publishing",
    "completed",
    "failed",
    "cancelled",
  ]),
  progress: z.object({
    scanned_seconds: z.number().nonnegative(),
    source_duration_seconds: z.number().positive(),
    percent: z.number().min(0).max(100),
    sampled_frames: z.number().int().nonnegative(),
    positive_frames: z.number().int().nonnegative(),
  }),
  revisions: z.object({
    analyzer: z.string(),
    model: z.string(),
    taxonomy: z.string(),
    config: z.string(),
  }),
  result: z.object({
    event_count: z.number().int().nonnegative(),
    bookmark_count: z.number().int().nonnegative(),
  }),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  retry_count: z.number().int().nonnegative(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  started_at: z.string().datetime().nullable(),
  completed_at: z.string().datetime().nullable(),
  cancelled_at: z.string().datetime().nullable(),
});

export const contentAnalysisJobResponseSchema = z.object({
  success: z.literal(true),
  data: contentAnalysisPublicRunSchema,
});

export const contentAnalysisStartedResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.object({
      job: contentAnalysisPublicRunSchema,
      reused: z.boolean(),
    }),
    message: z.string(),
  })
  .meta({
    headers: {
      Location: {
        description: "Canonical URL of the accepted analysis job",
        type: "string",
      },
    },
  });

export const startContentAnalysisSchema = z
  .object({
    videoId: z.number().int().positive(),
    userId: z.number().int().positive(),
    profile: contentAnalysisProfileSchema.default("balanced"),
    categories: z
      .array(nudityCategorySchema)
      .min(1)
      .refine((categories) => new Set(categories).size === categories.length, {
        message: "categories must not contain duplicates",
      })
      .optional(),
    force: z.boolean().default(false),
    idempotencyKey: z.string().trim().min(1).max(255).optional(),
  })
  .strict();

export const contentAnalysisJobPayloadSchema = z
  .object({ runId: z.number().int().positive() })
  .strict();

const contentAnalysisActivePhaseSchema = z.enum([
  "extracting",
  "analyzing",
  "refining",
  "condensing",
  "publishing",
]);

export const contentAnalysisCheckpointSchema = z
  .object({
    stage: contentAnalysisActivePhaseSchema,
    completedUnits: z.number().finite().nonnegative(),
    totalUnits: z.number().finite().positive(),
    data: z
      .object({
        version: z.literal(1),
        phase: contentAnalysisActivePhaseSchema,
        scannedSeconds: z.number().finite().nonnegative(),
        sampledFrames: z.number().int().nonnegative(),
        positiveFrames: z.number().int().nonnegative(),
        cursor: z
          .object({
            chunkIndex: z.number().int().nonnegative(),
            itemOffset: z.number().int().nonnegative().optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((checkpoint, context) => {
    if (
      checkpoint.stage !== checkpoint.data.phase ||
      checkpoint.completedUnits !== checkpoint.data.scannedSeconds ||
      checkpoint.completedUnits > checkpoint.totalUnits ||
      checkpoint.data.positiveFrames > checkpoint.data.sampledFrames ||
      new TextEncoder().encode(JSON.stringify(checkpoint)).byteLength > 16_384
    ) {
      context.addIssue({
        code: "custom",
        message: "Invalid or oversized content analysis checkpoint",
      });
    }
  });
