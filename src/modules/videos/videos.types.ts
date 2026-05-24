import { z } from "zod";
import type { Creator } from "@/modules/creators/creators.types";
import type { Tag } from "@/modules/tags/tags.types";
import type { Studio } from "@/modules/studios/studios.types";
import type {
  VideoCollectionContext,
  VideoCollectionNeighbors,
} from "@/modules/video-collections/video-collections.types";

export type VideoInclude =
  | "collection"
  | "collection_neighbors"
  | "creators"
  | "tags"
  | "studios";
export type VideoListInclude = Exclude<VideoInclude, "collection_neighbors">;

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
  is_available: boolean;
  last_verified_at: string | null;
  indexed_at: string;
  created_at: string;
  updated_at: string;
  is_favorite: boolean;
  thumbnail_id?: number | null;
  thumbnail_url?: string | null;
  collection?: VideoCollectionContext | null;
  collection_neighbors?: VideoCollectionNeighbors | null;
  creators?: Creator[];
  tags?: Tag[];
  studios?: Studio[];
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
  searchFullPath?: boolean;
  sort?: string;
  order?: "asc" | "desc";
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
  matchMode?: "any" | "all";
  ids?: number[];

  // Presence flags
  isFavorite?: boolean;
  hasThumbnail?: boolean;
  isAvailable?: boolean;

  // Relationship presence filters
  hasTags?: boolean;
  hasCreator?: boolean;
  hasStudio?: boolean;
  hasRating?: boolean;
  include?: VideoListInclude[];
}

export interface BulkUpdateCreatorsInput {
  videoIds: number[];
  creatorIds: number[];
  action: "add" | "remove";
}

export interface BulkUpdateTagsInput {
  videoIds: number[];
  tagIds: number[];
  action: "add" | "remove";
}

export interface BulkUpdateStudiosInput {
  videoIds: number[];
  studioIds: number[];
  action: "add" | "remove";
}

export interface BulkUpdateFavoritesInput {
  videoIds: number[];
  isFavorite: boolean;
}

export interface NextVideoOptions extends ListVideosOptions {
  currentId: number;
  direction?: "next" | "previous";
}

export interface NextVideoResult {
  video: Video | null;
  meta: {
    remaining: number;
    total_matching: number;
    has_wrapped: boolean;
  };
}

export interface TriageQueueOptions extends ListVideosOptions {
  queueLimit?: number;
  queueOffset?: number;
}

export interface TriageQueueResult {
  ids: number[];
  total: number;
}

export interface CompressionSuggestion {
  video_id: number;
  file_name: string;
  file_size_bytes: number;
  width: number | null;
  height: number | null;
  codec: string | null;
  bitrate: number | null;
  fps: number | null;
  duration_seconds: number | null;
  is_favorite: boolean;
  bytes_per_second: number | null;
  estimated_output_bytes: number;
  estimated_savings_bytes: number;
  estimated_savings_percent: number;
  confidence: "high" | "medium" | "low";
  priority_score: number;
  recommended_preset: string;
  recommended_preset_name: string;
  reasons: string[];
  thumbnail_id?: number | null;
  thumbnail_url?: string | null;
}

export interface CompressionSuggestionsSummary {
  total_candidates: number;
  total_estimated_savings_bytes: number;
  avg_estimated_savings_percent: number;
  historical_accuracy_note: string;
}

export interface RelatedVideo {
  video: Video;
  score: number;
  reasons: string[];
}

export interface RelatedVideosOptions {
  limit?: number;
  refresh?: boolean;
}

export interface RelatedVideosResult {
  data: RelatedVideo[];
  meta: {
    computed_at: string | null;
    refreshed: boolean;
    candidate_count: number;
  };
}
