import { z } from "zod";

export const cleanupDispositionSchema = z.enum([
  "unreviewed",
  "keep",
  "delete",
  "later",
]);

export const cleanupCandidatesQuerySchema = z.object({
  disposition: cleanupDispositionSchema.default("unreviewed"),
  limit: z.coerce.number().int().positive().max(100).default(24),
  offset: z.coerce.number().int().nonnegative().default(0),
});

export const cleanupVideoParamsSchema = z.object({
  videoId: z.coerce.number().int().positive(),
});

export const saveCleanupReviewSchema = z.object({
  disposition: cleanupDispositionSchema,
  expected_revision: z.number().int().nonnegative().default(0),
});

const creatorSchema = z.object({ id: z.number(), name: z.string() });
const cleanupCandidateSchema = z.object({
  id: z.number(),
  title: z.string().nullable(),
  file_name: z.string(),
  file_size_bytes: z.number(),
  duration_seconds: z.number().nullable(),
  indexed_at: z.string(),
  codec: z.string().nullable(),
  bitrate: z.number().nullable(),
  thumbnail_url: z.string().nullable(),
  creators: z.array(creatorSchema),
  engagement: z.object({
    play_count: z.number(),
    total_watch_seconds: z.number(),
    watched_fraction: z.number(),
    last_watched_at: z.string().nullable(),
  }),
  protections: z.object({
    favorite: z.boolean(),
    favorited_creator: z.boolean(),
    high_rating: z.boolean(),
    bookmark: z.boolean(),
    playlist: z.boolean(),
    collection: z.boolean(),
    active_job: z.boolean(),
  }),
  reasons: z.array(z.string()),
  eligible: z.boolean(),
  disposition: cleanupDispositionSchema,
  revision: z.number(),
  reviewed_at: z.string().nullable(),
});

export const cleanupCandidatesResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(cleanupCandidateSchema),
  pagination: z.object({
    offset: z.number(),
    limit: z.number(),
    total: z.number(),
  }),
});

const countBytesSchema = z.object({ count: z.number(), bytes: z.number() });
export const cleanupOverviewResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    policy: z.object({
      min_age_days: z.number(),
      max_watch_seconds: z.number(),
      max_watch_fraction: z.number(),
    }),
    library: countBytesSchema,
    quick_wins: z.object({
      count: z.number(),
      bytes: z.number(),
      unreviewed_count: z.number(),
      unreviewed_bytes: z.number(),
    }),
    decisions: z.object({
      keep: countBytesSchema,
      delete: countBytesSchema,
      later: countBytesSchema,
    }),
    rewards: z.object({
      reviewed_count: z.number(),
      reviewed_bytes: z.number(),
      today_count: z.number(),
      daily_goal: z.number(),
      streak_days: z.number(),
      activity: z.array(
        z.object({ date: z.string(), count: z.number(), bytes: z.number() })
      ),
    }),
  }),
});

export const saveCleanupReviewResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    video_id: z.number(),
    disposition: cleanupDispositionSchema,
    revision: z.number(),
    reviewed_at: z.string().nullable(),
  }),
});

export const cleanupErrorResponseSchema = z.object({
  success: z.literal(false),
  error: z.object({ message: z.string(), statusCode: z.number() }),
});
