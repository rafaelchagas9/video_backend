import { z } from "zod";

// Re-export from types for consistency
export { createRatingSchema, updateRatingSchema } from "./ratings.types";

// Request schemas
export const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

// Response schemas
const ratingSchema = z.object({
  id: z.number(),
  video_id: z.number(),
  rating: z.number().int().min(1).max(5),
  comment: z.string().nullable(),
  rated_at: z.string(),
});

const errorSchema = z.object({
  message: z.string(),
  statusCode: z.number(),
});

export const ratingResponseSchema = z.object({
  success: z.literal(true),
  data: ratingSchema,
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
