import { z } from "zod";

// Re-export from types for consistency
export { createCreatorSchema, updateCreatorSchema } from "./creators.types";

// Request schemas
export const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

// Response schemas
const creatorSchema = z.object({
  id: z.number(),
  name: z.string(),
  description: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

const videoSchema = z.object({
  id: z.number(),
  file_path: z.string(),
  file_name: z.string(),
  directory_id: z.number(),
  file_size_bytes: z.number(),
  duration_seconds: z.number().nullable(),
  title: z.string().nullable(),
  is_available: z.number(),
  created_at: z.string(),
});

const errorSchema = z.object({
  message: z.string(),
  statusCode: z.number(),
});

export const creatorResponseSchema = z.object({
  success: z.literal(true),
  data: creatorSchema,
  message: z.string().optional(),
});

export const creatorListResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(creatorSchema),
});

export const creatorVideosResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(videoSchema),
});

export const messageResponseSchema = z.object({
  success: z.literal(true),
  message: z.string(),
});

export const errorResponseSchema = z.object({
  success: z.literal(false),
  error: errorSchema,
});
