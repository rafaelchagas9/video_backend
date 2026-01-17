import { z } from "zod";

// Storage Stats Types
export interface DirectoryStorageInfo {
  directory_id: number;
  path: string;
  size_bytes: number;
  video_count: number;
}

export interface StorageSnapshot {
  id: number;
  total_video_size_bytes: number;
  total_video_count: number;
  thumbnails_size_bytes: number;
  storyboards_size_bytes: number;
  profile_pictures_size_bytes: number;
  converted_size_bytes: number;
  database_size_bytes: number;
  directory_breakdown: DirectoryStorageInfo[] | null;
  created_at: string;
}

export interface StorageSnapshotRow {
  id: number;
  total_video_size_bytes: number;
  total_video_count: number;
  thumbnails_size_bytes: number;
  storyboards_size_bytes: number;
  profile_pictures_size_bytes: number;
  converted_size_bytes: number;
  database_size_bytes: number;
  directory_breakdown: string | null;
  created_at: string;
}

export interface CurrentStorageStats {
  total_video_size_bytes: number;
  total_video_count: number;
  thumbnails_size_bytes: number;
  storyboards_size_bytes: number;
  profile_pictures_size_bytes: number;
  converted_size_bytes: number;
  database_size_bytes: number;
  directory_breakdown: DirectoryStorageInfo[];
  total_managed_size_bytes: number;
}

// Library Stats Types
export interface ResolutionBreakdown {
  resolution: string;
  count: number;
  percentage: number;
}

export interface CodecBreakdown {
  codec: string;
  count: number;
  percentage: number;
}

export interface LibrarySnapshot {
  id: number;
  total_video_count: number;
  available_video_count: number;
  unavailable_video_count: number;
  total_size_bytes: number;
  average_size_bytes: number;
  total_duration_seconds: number;
  average_duration_seconds: number;
  resolution_breakdown: ResolutionBreakdown[] | null;
  codec_breakdown: CodecBreakdown[] | null;
  created_at: string;
}

export interface LibrarySnapshotRow {
  id: number;
  total_video_count: number;
  available_video_count: number;
  unavailable_video_count: number;
  total_size_bytes: number;
  average_size_bytes: number;
  total_duration_seconds: number;
  average_duration_seconds: number;
  resolution_breakdown: string | null;
  codec_breakdown: string | null;
  created_at: string;
}

export interface CurrentLibraryStats {
  total_video_count: number;
  available_video_count: number;
  unavailable_video_count: number;
  total_size_bytes: number;
  average_size_bytes: number;
  total_duration_seconds: number;
  average_duration_seconds: number;
  resolution_breakdown: ResolutionBreakdown[];
  codec_breakdown: CodecBreakdown[];
}

// Content Stats Types
export interface TopItem {
  id: number;
  name: string;
  video_count: number;
}

export interface ContentSnapshot {
  id: number;
  videos_without_tags: number;
  videos_without_creators: number;
  videos_without_ratings: number;
  videos_without_thumbnails: number;
  videos_without_storyboards: number;
  total_tags: number;
  total_creators: number;
  total_studios: number;
  total_playlists: number;
  top_tags: TopItem[] | null;
  top_creators: TopItem[] | null;
  created_at: string;
}

export interface ContentSnapshotRow {
  id: number;
  videos_without_tags: number;
  videos_without_creators: number;
  videos_without_ratings: number;
  videos_without_thumbnails: number;
  videos_without_storyboards: number;
  total_tags: number;
  total_creators: number;
  total_studios: number;
  total_playlists: number;
  top_tags: string | null;
  top_creators: string | null;
  created_at: string;
}

export interface CurrentContentStats {
  videos_without_tags: number;
  videos_without_creators: number;
  videos_without_ratings: number;
  videos_without_thumbnails: number;
  videos_without_storyboards: number;
  total_tags: number;
  total_creators: number;
  total_studios: number;
  total_playlists: number;
  top_tags: TopItem[];
  top_creators: TopItem[];
}

// Usage Stats Types
export interface TopWatched {
  video_id: number;
  title: string;
  play_count: number;
  total_watch_seconds: number;
}

export interface ActivityByHour {
  [hour: string]: number;
}

export interface UsageSnapshot {
  id: number;
  total_watch_time_seconds: number;
  total_play_count: number;
  unique_videos_watched: number;
  videos_never_watched: number;
  average_completion_rate: number | null;
  top_watched: TopWatched[] | null;
  activity_by_hour: ActivityByHour | null;
  created_at: string;
}

export interface UsageSnapshotRow {
  id: number;
  total_watch_time_seconds: number;
  total_play_count: number;
  unique_videos_watched: number;
  videos_never_watched: number;
  average_completion_rate: number | null;
  top_watched: string | null;
  activity_by_hour: string | null;
  created_at: string;
}

export interface CurrentUsageStats {
  total_watch_time_seconds: number;
  total_play_count: number;
  unique_videos_watched: number;
  videos_never_watched: number;
  average_completion_rate: number | null;
  top_watched: TopWatched[];
  activity_by_hour: ActivityByHour;
}

// Query params schemas
export const historyQuerySchema = z.object({
  days: z.coerce.number().min(1).max(365).default(30),
  limit: z.coerce.number().min(1).max(1000).default(100),
});

export type HistoryQueryParams = z.infer<typeof historyQuerySchema>;
