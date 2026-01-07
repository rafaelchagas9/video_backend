import { z } from "zod";

// Re-export from types for consistency
export { addFavoriteSchema } from "./favorites.types";

// Request schemas
export const videoIdParamSchema = z.object({
  video_id: z.coerce.number().int().positive(),
});

// Response schemas
const favoriteVideoSchema = z.object({
  id: z.number(),
  file_name: z.string(),
  title: z.string().nullable(),
  duration_seconds: z.number().nullable(),
  added_at: z.string(),
});

const errorSchema = z.object({
  message: z.string(),
  statusCode: z.number(),
});

export const favoritesListResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(favoriteVideoSchema),
});

export const favoriteCheckResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    is_favorite: z.boolean(),
  }),
});

export const messageResponseSchema = z.object({
  success: z.literal(true),
  message: z.string(),
});

export const errorResponseSchema = z.object({
  success: z.literal(false),
  error: errorSchema,
});
