import { z } from "zod";

export { watchUpdateSchema } from "./video-stats.types";

export const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const videoStatsSchema = z.object({
  user_id: z.number(),
  video_id: z.number(),
  play_count: z.number(),
  total_watch_seconds: z.number(),
  session_watch_seconds: z.number(),
  session_play_counted: z.number(),
  last_position_seconds: z.number().nullable(),
  last_played_at: z.string().nullable(),
  last_watch_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

const aggregateStatsSchema = z.object({
  video_id: z.number(),
  total_play_count: z.number(),
  total_watch_seconds: z.number(),
  last_played_at: z.string().nullable(),
});

const errorSchema = z.object({
  message: z.string(),
  statusCode: z.number(),
});

export const watchUpdateResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    stats: videoStatsSchema,
    aggregate: aggregateStatsSchema,
    play_count_incremented: z.boolean(),
  }),
});

export const statsResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    stats: videoStatsSchema,
    aggregate: aggregateStatsSchema,
  }),
});

export const errorResponseSchema = z.object({
  success: z.literal(false),
  error: errorSchema,
});
