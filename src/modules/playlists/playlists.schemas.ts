import { z } from "zod";
import { artworkSummarySchema } from "@/modules/artwork/artwork.schemas";

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

const parseIncludeList = (value: unknown) => {
  if (typeof value === "string" && value.trim()) {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return Array.isArray(value) ? value : undefined;
};

export const playlistQuerySchema = z.object({
  include: z
    .preprocess(
      parseIncludeList,
      z.array(z.enum(["artwork"])).default([]),
    )
    .optional(),
});

const parseNullableNumber = (val: unknown) => {
  if (val === null || val === undefined) {
    return null;
  }
  if (typeof val === "number") {
    return val;
  }
  if (typeof val === "string" && val.trim() !== "") {
    const parsed = Number.parseFloat(val);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
};

// Response schemas
const playlistSchema = z.object({
  id: z.number(),
  user_id: z.number(),
  name: z.string(),
  description: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  thumbnail_url: z.string().nullable().optional(),
  video_count: z.number(),
  watched_count: z.number(),
  runtime_seconds: z.number(),
  last_played_at: z.string().nullable(),
  resume: z
    .object({
      video_id: z.number(),
      position_seconds: z.number(),
    })
    .nullable(),
  artwork_source_video_id: z.number().nullable(),
  artwork: artworkSummarySchema.nullable().optional(),
});

const playlistVideoSchema = z.object({
  id: z.number(),
  file_name: z.string(),
  title: z.string().nullable(),
  duration_seconds: z.preprocess(parseNullableNumber, z.number().nullable()),
  position: z.number(),
  thumbnail_id: z.number().nullable(),
  thumbnail_url: z.string().nullable(),
  watched: z.boolean(),
  position_seconds: z.number().nullable(),
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

export const bulkUpdatePlaylistVideosSchema = z.object({
  videoIds: z.array(z.number().int().positive()).min(1),
  action: z.enum(["add", "remove"]),
});
