import { z } from 'zod';

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
  data: z.object({
    filter_key: z.string(),
    last_video_id: z.number().nullable(),
    processed_count: z.number(),
    total_count: z.number().nullable(),
    updated_at: z.string(),
  }).nullable(),
});

export const saveTriageProgressResponseSchema = z.object({
  success: z.literal(true),
  message: z.string(),
});

const errorSchema = z.object({
  message: z.string(),
  statusCode: z.number(),
});

export const errorResponseSchema = z.object({
  success: z.literal(false),
  error: errorSchema,
});
