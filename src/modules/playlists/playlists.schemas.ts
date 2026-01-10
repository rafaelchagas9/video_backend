import { z } from "zod";

// Re-export from types for consistency
export {
  createPlaylistSchema,
  updatePlaylistSchema,
  addVideoToPlaylistSchema,
  reorderPlaylistSchema,
} from "./playlists.types";

// Request schemas
export const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export const videoIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
  video_id: z.coerce.number().int().positive(),
});

// Response schemas
const playlistSchema = z.object({
  id: z.number(),
  user_id: z.number(),
  name: z.string(),
  description: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

const playlistVideoSchema = z.object({
  id: z.number(),
  file_name: z.string(),
  title: z.string().nullable(),
  duration_seconds: z.number().nullable(),
  position: z.number(),
  thumbnail_id: z.number().nullable(),
  thumbnail_url: z.string().nullable(),
});

const errorSchema = z.object({
  message: z.string(),
  statusCode: z.number(),
});

export const playlistResponseSchema = z.object({
  success: z.literal(true),
  data: playlistSchema,
  message: z.string().optional(),
});

export const playlistListResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(playlistSchema),
});

export const playlistVideosResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(playlistVideoSchema),
});

export const messageResponseSchema = z.object({
  success: z.literal(true),
  message: z.string(),
});

export const errorResponseSchema = z.object({
  success: z.literal(false),
  error: errorSchema,
});
