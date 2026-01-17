import { z } from "zod";

// Query schemas
export const historyQuerySchema = z.object({
  days: z.coerce.number().min(1).max(365).default(30),
  limit: z.coerce.number().min(1).max(1000).default(100),
});

// Common schemas
const errorSchema = z.object({
  message: z.string(),
  statusCode: z.number(),
});

export const errorResponseSchema = z.object({
  success: z.literal(false),
  error: errorSchema,
});

export const messageResponseSchema = z.object({
  success: z.literal(true),
  message: z.string(),
});

// Storage schemas
const directoryStorageInfoSchema = z.object({
  directory_id: z.number(),
  path: z.string(),
  size_bytes: z.number(),
  video_count: z.number(),
});

const currentStorageStatsSchema = z.object({
  total_video_size_bytes: z.number(),
  total_video_count: z.number(),
  thumbnails_size_bytes: z.number(),
  storyboards_size_bytes: z.number(),
  profile_pictures_size_bytes: z.number(),
  converted_size_bytes: z.number(),
  database_size_bytes: z.number(),
  directory_breakdown: z.array(directoryStorageInfoSchema),
  total_managed_size_bytes: z.number(),
});

const storageSnapshotSchema = z.object({
  id: z.number(),
  total_video_size_bytes: z.number(),
  total_video_count: z.number(),
  thumbnails_size_bytes: z.number(),
  storyboards_size_bytes: z.number(),
  profile_pictures_size_bytes: z.number(),
  converted_size_bytes: z.number(),
  database_size_bytes: z.number(),
  directory_breakdown: z.array(directoryStorageInfoSchema).nullable(),
  created_at: z.string(),
});

export const storageCurrentResponseSchema = z.object({
  success: z.literal(true),
  data: currentStorageStatsSchema,
});

export const storageHistoryResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(storageSnapshotSchema),
});

export const storageSnapshotResponseSchema = z.object({
  success: z.literal(true),
  data: storageSnapshotSchema,
  message: z.string(),
});

// Library schemas
const resolutionBreakdownSchema = z.object({
  resolution: z.string(),
  count: z.number(),
  percentage: z.number(),
});

const codecBreakdownSchema = z.object({
  codec: z.string(),
  count: z.number(),
  percentage: z.number(),
});

const currentLibraryStatsSchema = z.object({
  total_video_count: z.number(),
  available_video_count: z.number(),
  unavailable_video_count: z.number(),
  total_size_bytes: z.number(),
  average_size_bytes: z.number(),
  total_duration_seconds: z.number(),
  average_duration_seconds: z.number(),
  resolution_breakdown: z.array(resolutionBreakdownSchema),
  codec_breakdown: z.array(codecBreakdownSchema),
});

const librarySnapshotSchema = z.object({
  id: z.number(),
  total_video_count: z.number(),
  available_video_count: z.number(),
  unavailable_video_count: z.number(),
  total_size_bytes: z.number(),
  average_size_bytes: z.number(),
  total_duration_seconds: z.number(),
  average_duration_seconds: z.number(),
  resolution_breakdown: z.array(resolutionBreakdownSchema).nullable(),
  codec_breakdown: z.array(codecBreakdownSchema).nullable(),
  created_at: z.string(),
});

export const libraryCurrentResponseSchema = z.object({
  success: z.literal(true),
  data: currentLibraryStatsSchema,
});

export const libraryHistoryResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(librarySnapshotSchema),
});

export const librarySnapshotResponseSchema = z.object({
  success: z.literal(true),
  data: librarySnapshotSchema,
  message: z.string(),
});

// Content schemas
const topItemSchema = z.object({
  id: z.number(),
  name: z.string(),
  video_count: z.number(),
});

const currentContentStatsSchema = z.object({
  videos_without_tags: z.number(),
  videos_without_creators: z.number(),
  videos_without_ratings: z.number(),
  videos_without_thumbnails: z.number(),
  videos_without_storyboards: z.number(),
  total_tags: z.number(),
  total_creators: z.number(),
  total_studios: z.number(),
  total_playlists: z.number(),
  top_tags: z.array(topItemSchema),
  top_creators: z.array(topItemSchema),
});

const contentSnapshotSchema = z.object({
  id: z.number(),
  videos_without_tags: z.number(),
  videos_without_creators: z.number(),
  videos_without_ratings: z.number(),
  videos_without_thumbnails: z.number(),
  videos_without_storyboards: z.number(),
  total_tags: z.number(),
  total_creators: z.number(),
  total_studios: z.number(),
  total_playlists: z.number(),
  top_tags: z.array(topItemSchema).nullable(),
  top_creators: z.array(topItemSchema).nullable(),
  created_at: z.string(),
});

export const contentCurrentResponseSchema = z.object({
  success: z.literal(true),
  data: currentContentStatsSchema,
});

export const contentHistoryResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(contentSnapshotSchema),
});

export const contentSnapshotResponseSchema = z.object({
  success: z.literal(true),
  data: contentSnapshotSchema,
  message: z.string(),
});

// Usage schemas
const topWatchedSchema = z.object({
  video_id: z.number(),
  title: z.string(),
  play_count: z.number(),
  total_watch_seconds: z.number(),
});

const activityByHourSchema = z.record(z.string(), z.number());

const currentUsageStatsSchema = z.object({
  total_watch_time_seconds: z.number(),
  total_play_count: z.number(),
  unique_videos_watched: z.number(),
  videos_never_watched: z.number(),
  average_completion_rate: z.number().nullable(),
  top_watched: z.array(topWatchedSchema),
  activity_by_hour: activityByHourSchema,
});

const usageSnapshotSchema = z.object({
  id: z.number(),
  total_watch_time_seconds: z.number(),
  total_play_count: z.number(),
  unique_videos_watched: z.number(),
  videos_never_watched: z.number(),
  average_completion_rate: z.number().nullable(),
  top_watched: z.array(topWatchedSchema).nullable(),
  activity_by_hour: activityByHourSchema.nullable(),
  created_at: z.string(),
});

export const usageCurrentResponseSchema = z.object({
  success: z.literal(true),
  data: currentUsageStatsSchema,
});

export const usageHistoryResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(usageSnapshotSchema),
});

export const usageSnapshotResponseSchema = z.object({
  success: z.literal(true),
  data: usageSnapshotSchema,
  message: z.string(),
});

// All snapshots response (for manual trigger)
export const allSnapshotsResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    storage: storageSnapshotSchema,
    library: librarySnapshotSchema,
    content: contentSnapshotSchema,
    usage: usageSnapshotSchema,
  }),
  message: z.string(),
});

// Type exports
export type HistoryQuery = z.infer<typeof historyQuerySchema>;
