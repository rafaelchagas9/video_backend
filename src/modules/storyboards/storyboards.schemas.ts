import { z } from 'zod';

// Request schemas
export const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export const generateStoryboardBodySchema = z.object({
  tileWidth: z.number().min(64).max(512).optional(),
  tileHeight: z.number().min(36).max(288).optional(),
  intervalSeconds: z.number().min(1).max(60).optional(),
}).optional();

// Response schemas
export const storyboardSchema = z.object({
  id: z.number(),
  video_id: z.number(),
  sprite_path: z.string(),
  vtt_path: z.string(),
  tile_width: z.number(),
  tile_height: z.number(),
  tile_count: z.number(),
  interval_seconds: z.number(),
  sprite_size_bytes: z.number().nullable(),
  generated_at: z.string(),
});

export const storyboardResponseSchema = z.object({
  success: z.boolean(),
  data: storyboardSchema,
  message: z.string().optional(),
});

export const messageResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
});

export const errorResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  statusCode: z.number().optional(),
});
