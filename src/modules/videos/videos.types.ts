import { z } from "zod";
import type { Creator } from "@/modules/creators/creators.types";
import type { Tag } from "@/modules/tags/tags.types";
import type { Studio } from "@/modules/studios/studios.types";
import type {
  VideoCollectionContext,
  VideoCollectionNeighbors,
} from "@/modules/video-collections/video-collections.types";
import type { VideoArtworkSummary } from "@/modules/artwork/artwork.types";

export type VideoInclude =
  | "collection"
  | "collection_neighbors"
  | "creators"
  | "tags"
  | "studios"
  | "artwork"
  | "stats";
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
  studio_assignment_status: StudioAssignmentStatus;
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
  artwork?: VideoArtworkSummary | null;
  play_count?: number;
  last_played_at?: string | null;
}

export type StudioAssignmentStatus = "assigned" | "confirmed_none" | "unknown";

export function deriveStudioAssignmentStatus(
  hasStudio: boolean,
  confirmedAt: Date | string | null | undefined,
): StudioAssignmentStatus {
  if (hasStudio) return "assigned";
  return confirmedAt ? "confirmed_none" : "unknown";
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
  createdFrom?: string;
  createdBefore?: string;
  minPlayCount?: number;
  maxPlayCount?: number;
  lastPlayedBefore?: string;
  lastPlayedAfter?: string;

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
  studioAssignmentStatus?: StudioAssignmentStatus;
  hasRating?: boolean;
  include?: VideoListInclude[];
}

export interface RandomVideoOptions {
  directory_id?: number;
  include_hidden?: boolean;
  isAvailable?: boolean;
  hasTags?: boolean;
  hasCreator?: boolean;
  hasStudio?: boolean;
  studioAssignmentStatus?: StudioAssignmentStatus;
  hasRating?: boolean;
  creatorIds?: number[];
  tagIds?: number[];
  studioIds?: number[];
  matchMode?: "any" | "all";
  minPlayCount?: number;
  maxPlayCount?: number;
  lastPlayedBefore?: string;
  lastPlayedAfter?: string;
  limit?: number;
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
  historical_sample_count: number;
  prediction_error_percent: number | null;
  priority_score: number;
  recommended_preset: string;
  recommended_preset_name: string;
  expected_target_resolution: string;
  effective_resolution: string | null;
  profile_version: number;
  planned_video_bitrate: number;
  planned_max_bitrate: number;
  recommendation_tier: "recommended" | "marginal";
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

export interface UnavailableVideo {
  id: number;
  file_path: string;
  file_name: string;
  directory_id: number;
  directory_path: string | null;
  last_verified_at: string | null;
  thumbnail_url: string | null;
  artifacts: {
    thumbnail: boolean;
    storyboard: boolean;
    face_count: number;
    artwork_count: number;
    reclaimable_bytes: number;
  };
}
