import { z } from "zod";
import type { VideoArtworkSummary } from "@/modules/artwork/artwork.types";

export const videoCollectionKindValues = [
  "movie_series",
  "tv_series",
  "mini_series",
  "anthology",
  "other",
] as const;

export const videoCollectionEntryKindValues = [
  "movie",
  "episode",
  "special",
  "extra",
] as const;

export type VideoCollectionKind = (typeof videoCollectionKindValues)[number];
export type VideoCollectionEntryKind =
  (typeof videoCollectionEntryKindValues)[number];

export interface VideoCollection {
  id: number;
  title: string;
  kind: VideoCollectionKind;
  description: string | null;
  release_year: number | null;
  external_ids_json: string | null;
  entry_count?: number;
  watched_count: number;
  runtime_seconds: number;
  season_count: number;
  last_watched_at: string | null;
  resume: VideoCollectionResume | null;
  artwork_source_video_id: number | null;
  artwork?: VideoArtworkSummary | null;
  created_at: string;
  updated_at: string;
}

export interface VideoCollectionResume {
  entry_id: number;
  video_id: number;
  season_number: number | null;
  episode_number: number | null;
  position_seconds: number;
}

export interface VideoCollectionEntry {
  id: number;
  collection_id: number;
  video_id: number;
  entry_kind: VideoCollectionEntryKind;
  sequence_number: number | null;
  season_number: number | null;
  episode_number: number | null;
  episode_part: number | null;
  absolute_number: number | null;
  display_title_override: string | null;
  created_at: string;
  updated_at: string;
  video?: {
    id: number;
    file_name: string;
    title: string | null;
    thumbnail_id: number | null;
    thumbnail_url: string | null;
    is_available: boolean;
    duration_seconds: number | null;
    watched: boolean;
    position_seconds: number | null;
  };
}

export interface VideoCollectionContext {
  entry_id: number;
  collection_id: number;
  title: string;
  kind: VideoCollectionKind;
  description: string | null;
  release_year: number | null;
  entry: Omit<VideoCollectionEntry, "video">;
}

export interface VideoCollectionNeighborItem {
  video_id: number;
  entry_id: number;
  title: string | null;
  file_name: string;
  display_title_override: string | null;
  sequence_number: number | null;
  season_number: number | null;
  episode_number: number | null;
  episode_part: number | null;
  absolute_number: number | null;
  thumbnail_id: number | null;
  thumbnail_url: string | null;
}

export interface VideoCollectionNeighbors {
  previous: VideoCollectionNeighborItem | null;
  next: VideoCollectionNeighborItem | null;
}

export const createVideoCollectionSchema = z.object({
  title: z.string().min(1).max(255),
  kind: z.enum(videoCollectionKindValues),
  description: z.string().max(10000).nullable().optional(),
  release_year: z.number().int().min(1800).max(3000).nullable().optional(),
  external_ids_json: z.string().max(20000).nullable().optional(),
});

export const updateVideoCollectionSchema = createVideoCollectionSchema
  .partial()
  .extend({
    artwork_source_video_id: z.number().int().positive().optional(),
  });

export const createVideoCollectionEntrySchema = z
  .object({
    video_id: z.number().int().positive(),
    entry_kind: z.enum(videoCollectionEntryKindValues),
    sequence_number: z.number().int().min(1).nullable().optional(),
    season_number: z.number().int().min(0).nullable().optional(),
    episode_number: z.number().int().min(1).nullable().optional(),
    episode_part: z.number().int().min(1).nullable().optional(),
    absolute_number: z.number().int().min(1).nullable().optional(),
    display_title_override: z.string().max(255).nullable().optional(),
  })
  .refine(
    (data) =>
      (data.season_number == null && data.episode_number == null) ||
      (data.season_number != null && data.episode_number != null),
    {
      message:
        "season_number and episode_number must both be provided for episodic entries",
      path: ["season_number"],
    },
  );

export const reorderVideoCollectionEntriesSchema = z.object({
  entries: z
    .array(
      z
        .object({
          video_id: z.number().int().positive(),
          sequence_number: z.number().int().min(1).nullable().optional(),
          season_number: z.number().int().min(0).nullable().optional(),
          episode_number: z.number().int().min(1).nullable().optional(),
          episode_part: z.number().int().min(1).nullable().optional(),
          absolute_number: z.number().int().min(1).nullable().optional(),
        })
        .refine(
          (data) =>
            (data.season_number == null && data.episode_number == null) ||
            (data.season_number != null && data.episode_number != null),
          {
            message:
              "season_number and episode_number must both be provided together",
            path: ["season_number"],
          },
        ),
    )
    .min(1),
});

export type CreateVideoCollectionInput = z.infer<
  typeof createVideoCollectionSchema
>;
export type UpdateVideoCollectionInput = z.infer<
  typeof updateVideoCollectionSchema
>;
export type CreateVideoCollectionEntryInput = z.infer<
  typeof createVideoCollectionEntrySchema
>;
export type ReorderVideoCollectionEntriesInput = z.infer<
  typeof reorderVideoCollectionEntriesSchema
>;
