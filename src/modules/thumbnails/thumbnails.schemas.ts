import { z } from "zod";

// Re-export from types for consistency
export { generateThumbnailSchema } from "./thumbnails.types";

// Request schemas
export const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

// Response schemas
const thumbnailSchema = z.object({
  id: z.number(),
  video_id: z.number(),
  file_path: z.string(),
  file_size_bytes: z.number().nullable().optional(),
  timestamp_seconds: z.number(),
  width: z.number(),
  height: z.number(),
  generated_at: z.string(),
});

const errorSchema = z.object({
  message: z.string(),
  statusCode: z.number(),
});

export const thumbnailResponseSchema = z.object({
  success: z.literal(true),
  data: thumbnailSchema,
  message: z.string().optional(),
});

export const thumbnailListResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(thumbnailSchema),
});

export const messageResponseSchema = z.object({
  success: z.literal(true),
  message: z.string(),
});

export const errorResponseSchema = z.object({
  success: z.literal(false),
  error: errorSchema,
});
