import { z } from "zod";

// Re-export from types for consistency
export { createBookmarkSchema, updateBookmarkSchema } from "./bookmarks.types";

// Request schemas
export const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

// Response schemas
const bookmarkSchema = z.object({
  id: z.number(),
  video_id: z.number(),
  user_id: z.number(),
  timestamp_seconds: z.number(),
  name: z.string(),
  description: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

const errorSchema = z.object({
  message: z.string(),
  statusCode: z.number(),
});

export const bookmarkResponseSchema = z.object({
  success: z.literal(true),
  data: bookmarkSchema,
  message: z.string().optional(),
});

export const messageResponseSchema = z.object({
  success: z.literal(true),
  message: z.string(),
});

export const errorResponseSchema = z.object({
  success: z.literal(false),
  error: errorSchema,
});
