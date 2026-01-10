import { z } from 'zod';

export interface Video {
  id: number;
  file_path: string;
  file_name: string;
  directory_id: number;
  file_size_bytes: number;
  file_hash: string | null;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  codec: string | null;
  bitrate: number | null;
  fps: number | null;
  audio_codec: string | null;
  title: string | null;
  description: string | null;
  themes: string | null;
  is_available: number;
  last_verified_at: string | null;
  indexed_at: string;
  created_at: string;
  updated_at: string;
  is_favorite: boolean;
  thumbnail_id?: number | null;
}

export interface VideoMetadata {
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  codec: string | null;
  bitrate: number | null;
  fps: number | null;
  audio_codec: string | null;
}

export const updateVideoSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  themes: z.string().optional(),
});

export type UpdateVideoInput = z.infer<typeof updateVideoSchema>;

export interface ListVideosOptions {
  // Existing pagination and search
  page?: number;
  limit?: number;
  directory_id?: number;
  search?: string;
  sort?: string;
  order?: 'asc' | 'desc';
  include_hidden?: boolean;

  // Resolution filters
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;

  // File size filters (in bytes)
  minFileSize?: number;
  maxFileSize?: number;

  // Duration filters (in seconds)
  minDuration?: number;
  maxDuration?: number;

  // Codec filters
  codec?: string;
  audioCodec?: string;

  // Bitrate filters (in bits per second)
  minBitrate?: number;
  maxBitrate?: number;

  // FPS filters
  minFps?: number;
  maxFps?: number;

  // Rating filters (1-5 scale)
  minRating?: number;
  maxRating?: number;

  // Relationship filters
  creatorIds?: number[];
  tagIds?: number[];
  studioIds?: number[];
  matchMode?: 'any' | 'all';

  // Presence flags
  isFavorite?: boolean;
  hasThumbnail?: boolean;
  isAvailable?: boolean;
}

export interface BulkUpdateCreatorsInput {
  videoIds: number[];
  creatorIds: number[];
  action: 'add' | 'remove';
}

export interface BulkUpdateTagsInput {
  videoIds: number[];
  tagIds: number[];
  action: 'add' | 'remove';
}

export interface BulkUpdateStudiosInput {
  videoIds: number[];
  studioIds: number[];
  action: 'add' | 'remove';
}

export interface BulkUpdateFavoritesInput {
  videoIds: number[];
  isFavorite: boolean;
}
