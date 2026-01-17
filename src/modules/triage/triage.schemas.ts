import { z } from "zod";

export const saveTriageProgressSchema = z.object({
  filterKey: z.string().min(1).max(2000),
  lastVideoId: z.number().int().positive(),
  processedCount: z.number().int().nonnegative(),
  totalCount: z.number().int().positive().optional(),
});

export const getTriageProgressQuerySchema = z.object({
  filterKey: z.string().min(1).max(2000),
});

export const triageProgressResponseSchema = z.object({
  success: z.literal(true),
  data: z
    .object({
      filter_key: z.string(),
      last_video_id: z.number().nullable(),
      processed_count: z.number(),
      total_count: z.number().nullable(),
      updated_at: z.string(),
    })
    .nullable(),
});

export const saveTriageProgressResponseSchema = z.object({
  success: z.literal(true),
  message: z.string(),
});

export const triageBulkActionsSchema = z.object({
  videoIds: z.array(z.number().int().positive()).min(1).max(1000),
  actions: z.object({
    addCreatorIds: z.array(z.number().int().positive()).optional(),
    removeCreatorIds: z.array(z.number().int().positive()).optional(),
    addTagIds: z.array(z.number().int().positive()).optional(),
    removeTagIds: z.array(z.number().int().positive()).optional(),
    addStudioIds: z.array(z.number().int().positive()).optional(),
    removeStudioIds: z.array(z.number().int().positive()).optional(),
  }),
});

export const triageBulkActionsResultSchema = z.object({
  success: z.literal(true),
  data: z.object({
    processed: z.number(),
    errors: z.number(),
    details: z.object({
      creators_added: z.number(),
      creators_removed: z.number(),
      tags_added: z.number(),
      tags_removed: z.number(),
      studios_added: z.number(),
      studios_removed: z.number(),
    }),
  }),
});

export const triageStatisticsResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    total_untagged_videos: z.number(),
    total_videos: z.number(),
    tagged_percentage: z.number(),
    recent_progress: z.object({
      last_24h_processed: z.number(),
      last_7d_processed: z.number(),
      avg_daily_rate: z.number(),
    }),
    filter_breakdown: z.array(
      z.object({
        filter_key: z.string(),
        total: z.number(),
        processed_count: z.number(),
        percentage: z.number(),
      }),
    ),
    top_directories: z.array(
      z.object({
        directory_id: z.number(),
        path: z.string(),
        untagged_count: z.number(),
      }),
    ),
  }),
});

const errorSchema = z.object({
  message: z.string(),
  statusCode: z.number(),
});

export const errorResponseSchema = z.object({
  success: z.literal(false),
  error: errorSchema,
});
