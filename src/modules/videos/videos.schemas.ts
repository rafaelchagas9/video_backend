import { z } from "zod";

// Re-export from types for consistency
export { updateVideoSchema } from "./videos.types";

// Request schemas
export const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

// Helper to parse comma-separated IDs
const parseCommaSeparatedIds = (val: unknown) => {
  if (typeof val === "string" && val.trim().length > 0) {
    return val
      .split(",")
      .map((id) => parseInt(id.trim()))
      .filter((id) => !isNaN(id));
  }
  if (Array.isArray(val)) {
    return val;
  }
  return undefined;
};

// Helper to parse boolean from query string
const parseBooleanQuery = (val: unknown) => {
  if (typeof val === "boolean") {
    return val;
  }
  if (typeof val === "string") {
    return val.toLowerCase() === "true";
  }
  return undefined;
};

export const listVideosQuerySchema = z
  .object({
    // Existing pagination and search
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(20),
    directory_id: z.coerce.number().int().positive().optional(),
    search: z.string().optional(),
    sort: z
      .enum([
        "created_at",
        "file_name",
        "duration_seconds",
        "file_size_bytes",
        "indexed_at",
        "width",
        "height",
        "bitrate",
        "fps",
      ])
      .default("created_at"),
    order: z.enum(["asc", "desc"]).default("desc"),
    include_hidden: z.preprocess(parseBooleanQuery, z.boolean()).default(false),

    // Resolution filters
    minWidth: z.coerce.number().int().positive().optional(),
    maxWidth: z.coerce.number().int().positive().optional(),
    minHeight: z.coerce.number().int().positive().optional(),
    maxHeight: z.coerce.number().int().positive().optional(),

    // File size filters (in bytes)
    minFileSize: z.coerce.number().int().positive().optional(),
    maxFileSize: z.coerce.number().int().positive().optional(),

    // Duration filters (in seconds)
    minDuration: z.coerce.number().positive().optional(),
    maxDuration: z.coerce.number().positive().optional(),

    // Codec filters (exact match, case-insensitive)
    codec: z.string().optional(),
    audioCodec: z.string().optional(),

    // Bitrate filters (in bits per second)
    minBitrate: z.coerce.number().int().positive().optional(),
    maxBitrate: z.coerce.number().int().positive().optional(),

    // FPS filters
    minFps: z.coerce.number().positive().optional(),
    maxFps: z.coerce.number().positive().optional(),

    // Rating filters (1-5 scale)
    minRating: z.coerce.number().int().min(1).max(5).optional(),
    maxRating: z.coerce.number().int().min(1).max(5).optional(),

    // Relationship filters (comma-separated IDs converted to arrays)
    creatorIds: z
      .preprocess(
        parseCommaSeparatedIds,
        z.array(z.number().int().positive()).optional(),
      )
      .optional(),
    tagIds: z
      .preprocess(
        parseCommaSeparatedIds,
        z.array(z.number().int().positive()).optional(),
      )
      .optional(),
    studioIds: z
      .preprocess(
        parseCommaSeparatedIds,
        z.array(z.number().int().positive()).optional(),
      )
      .optional(),
    matchMode: z.enum(["any", "all"]).default("any"),

    // Presence flags
    isFavorite: z.preprocess(parseBooleanQuery, z.boolean()).optional(),
    hasThumbnail: z.preprocess(parseBooleanQuery, z.boolean()).optional(),
    isAvailable: z.preprocess(parseBooleanQuery, z.boolean()).optional(),

    // Relationship presence filters
    hasTags: z.preprocess(parseBooleanQuery, z.boolean()).optional(),
    hasCreator: z.preprocess(parseBooleanQuery, z.boolean()).optional(),
    hasStudio: z.preprocess(parseBooleanQuery, z.boolean()).optional(),
    hasRating: z.preprocess(parseBooleanQuery, z.boolean()).optional(),
  })
  .refine(
    (data) => {
      // Validate that min values are not greater than max values
      if (
        data.minWidth !== undefined &&
        data.maxWidth !== undefined &&
        data.minWidth > data.maxWidth
      ) {
        return false;
      }
      if (
        data.minHeight !== undefined &&
        data.maxHeight !== undefined &&
        data.minHeight > data.maxHeight
      ) {
        return false;
      }
      if (
        data.minFileSize !== undefined &&
        data.maxFileSize !== undefined &&
        data.minFileSize > data.maxFileSize
      ) {
        return false;
      }
      if (
        data.minDuration !== undefined &&
        data.maxDuration !== undefined &&
        data.minDuration > data.maxDuration
      ) {
        return false;
      }
      if (
        data.minBitrate !== undefined &&
        data.maxBitrate !== undefined &&
        data.minBitrate > data.maxBitrate
      ) {
        return false;
      }
      if (
        data.minFps !== undefined &&
        data.maxFps !== undefined &&
        data.minFps > data.maxFps
      ) {
        return false;
      }
      if (
        data.minRating !== undefined &&
        data.maxRating !== undefined &&
        data.minRating > data.maxRating
      ) {
        return false;
      }
      return true;
    },
    {
      message: "Minimum value cannot be greater than maximum value",
    },
  );

export const creatorIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
  creator_id: z.coerce.number().int().positive(),
});

export const tagIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
  tag_id: z.coerce.number().int().positive(),
});

export const metadataKeyParamSchema = z.object({
  id: z.coerce.number().int().positive(),
  key: z.string().min(1),
});

export const addCreatorBodySchema = z.object({
  creator_id: z.number().int().positive(),
});

export const addTagBodySchema = z.object({
  tag_id: z.number().int().positive(),
});

export const setMetadataBodySchema = z.object({
  key: z.string().min(1).max(255),
  value: z.string().max(10000),
});

// Response schemas
const videoSchema = z.object({
  id: z.number(),
  file_path: z.string(),
  file_name: z.string(),
  directory_id: z.number(),
  file_size_bytes: z.number(),
  file_hash: z.string().nullable(),
  duration_seconds: z.number().nullable(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  codec: z.string().nullable(),
  bitrate: z.number().nullable(),
  fps: z.number().nullable(),
  audio_codec: z.string().nullable(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  themes: z.string().nullable(),
  is_available: z.number(),
  last_verified_at: z.string().nullable(),
  indexed_at: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  thumbnail_id: z.number().nullable().optional(),
  thumbnail_url: z.string().nullable().optional(),
  thumbnail_base64: z.string().nullable().optional(),
  is_favorite: z.boolean(),
});

const creatorSchema = z.object({
  id: z.number(),
  name: z.string(),
  description: z.string().nullable(),
});

const tagSchema = z.object({
  id: z.number(),
  name: z.string(),
  parent_id: z.number().nullable(),
  color: z.string().nullable().optional(),
});

const metadataSchema = z.object({
  key: z.string(),
  value: z.string(),
});

const ratingSchema = z.object({
  id: z.number(),
  rating: z.number(),
  comment: z.string().nullable(),
  rated_at: z.string(),
});

const bookmarkSchema = z.object({
  id: z.number(),
  timestamp_seconds: z.number(),
  name: z.string(),
  description: z.string().nullable(),
  created_at: z.string(),
});

const studioSchema = z.object({
  id: z.number(),
  name: z.string(),
  description: z.string().nullable(),
  profile_picture_path: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

const errorSchema = z.object({
  message: z.string(),
  statusCode: z.number(),
});

export const videoResponseSchema = z.object({
  success: z.literal(true),
  data: videoSchema,
  message: z.string().optional(),
});

export const videoListResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(videoSchema),
  pagination: z.object({
    page: z.number(),
    limit: z.number(),
    total: z.number(),
    totalPages: z.number(),
  }),
});

export const creatorsResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(creatorSchema),
});

export const tagsResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(tagSchema),
});

export const metadataResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(metadataSchema),
});

export const ratingsResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(ratingSchema),
  average: z.number().nullable(),
});

export const ratingCreatedResponseSchema = z.object({
  success: z.literal(true),
  data: ratingSchema,
  message: z.string(),
});

export const bookmarksResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(bookmarkSchema),
});

export const bookmarkCreatedResponseSchema = z.object({
  success: z.literal(true),
  data: bookmarkSchema,
  message: z.string(),
});

export const studiosResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(studioSchema),
});

export const studioIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
  studio_id: z.coerce.number().int().positive(),
});

export const messageResponseSchema = z.object({
  success: z.literal(true),
  message: z.string(),
});

export const errorResponseSchema = z.object({
  success: z.literal(false),
  error: errorSchema,
});

// Bulk Action Schemas
export const bulkDeleteVideosSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1),
});

export const bulkUpdateCreatorsSchema = z.object({
  videoIds: z.array(z.number().int().positive()).min(1),
  creatorIds: z.array(z.number().int().positive()).min(1),
  action: z.enum(["add", "remove"]),
});

export const bulkUpdateTagsSchema = z.object({
  videoIds: z.array(z.number().int().positive()).min(1),
  tagIds: z.array(z.number().int().positive()).min(1),
  action: z.enum(["add", "remove"]),
});

export const bulkUpdateStudiosSchema = z.object({
  videoIds: z.array(z.number().int().positive()).min(1),
  studioIds: z.array(z.number().int().positive()).min(1),
  action: z.enum(["add", "remove"]),
});

export const bulkUpdateFavoritesSchema = z.object({
  videoIds: z.array(z.number().int().positive()).min(1),
  isFavorite: z.boolean(),
});

// Next video navigation
export const nextVideoQuerySchema = listVideosQuerySchema.extend({
  currentId: z.coerce.number().int().positive(),
  direction: z.enum(["next", "previous"]).default("next"),
});

export const nextVideoResponseSchema = z.object({
  success: z.literal(true),
  data: videoSchema.nullable(),
  meta: z.object({
    remaining: z.number(),
    total_matching: z.number(),
    has_wrapped: z.boolean(),
  }),
});

// Triage queue (lightweight ID list)
export const triageQueueQuerySchema = listVideosQuerySchema.extend({
  queueLimit: z.coerce.number().int().positive().max(1000).default(100),
  queueOffset: z.coerce.number().int().nonnegative().default(0),
});

export const triageQueueResponseSchema = z.object({
  success: z.literal(true),
  ids: z.array(z.number()),
  total: z.number(),
});

// Compression suggestions
export const compressionSuggestionsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
});

const compressionSuggestionSchema = z.object({
  video_id: z.number(),
  file_name: z.string(),
  file_size_bytes: z.number(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  codec: z.string().nullable(),
  bitrate: z.number().nullable(),
  fps: z.number().nullable(),
  duration_seconds: z.number().nullable(),
  total_play_count: z.number(),
  total_watch_seconds: z.number(),
  last_played_at: z.string().nullable(),
  technical_score: z.number(),
  usage_score: z.number(),
  recommended_actions: z.array(z.string()),
  reasons: z.array(z.string()),
});

export const compressionSuggestionsResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(compressionSuggestionSchema),
});

// Duplicate files
const duplicateVideoSchema = z.object({
  id: z.number(),
  file_name: z.string(),
  file_path: z.string(),
  file_size_bytes: z.number(),
  indexed_at: z.string(),
});

const duplicateGroupSchema = z.object({
  file_hash: z.string(),
  count: z.number(),
  total_size_bytes: z.number(),
  videos: z.array(duplicateVideoSchema),
});

export const duplicatesResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(duplicateGroupSchema),
});
