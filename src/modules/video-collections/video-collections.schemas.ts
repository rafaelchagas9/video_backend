import { z } from "zod";
import {
  videoCollectionEntryKindValues,
  videoCollectionKindValues,
} from "./video-collections.types";

export {
  createVideoCollectionSchema,
  updateVideoCollectionSchema,
  createVideoCollectionEntrySchema,
  reorderVideoCollectionEntriesSchema,
} from "./video-collections.types";

export const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export const videoIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
  video_id: z.coerce.number().int().positive(),
});

const entrySchema = z.object({
  id: z.number(),
  collection_id: z.number(),
  video_id: z.number(),
  entry_kind: z.enum(videoCollectionEntryKindValues),
  sequence_number: z.number().nullable(),
  season_number: z.number().nullable(),
  episode_number: z.number().nullable(),
  episode_part: z.number().nullable(),
  absolute_number: z.number().nullable(),
  display_title_override: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  video: z
    .object({
      id: z.number(),
      file_name: z.string(),
      title: z.string().nullable(),
      thumbnail_id: z.number().nullable(),
      thumbnail_url: z.string().nullable(),
      is_available: z.boolean(),
    })
    .optional(),
});

export const videoCollectionSummarySchema = z.object({
  id: z.number(),
  title: z.string(),
  kind: z.enum(videoCollectionKindValues),
  description: z.string().nullable(),
  release_year: z.number().nullable(),
  external_ids_json: z.string().nullable(),
  entry_count: z.number().optional(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const videoCollectionContextSchema = z.object({
  entry_id: z.number(),
  collection_id: z.number(),
  title: z.string(),
  kind: z.enum(videoCollectionKindValues),
  description: z.string().nullable(),
  release_year: z.number().nullable(),
  entry: entrySchema.omit({ video: true }),
});

const neighborItemSchema = z.object({
  video_id: z.number(),
  entry_id: z.number(),
  title: z.string().nullable(),
  file_name: z.string(),
  display_title_override: z.string().nullable(),
  sequence_number: z.number().nullable(),
  season_number: z.number().nullable(),
  episode_number: z.number().nullable(),
  episode_part: z.number().nullable(),
  absolute_number: z.number().nullable(),
  thumbnail_id: z.number().nullable(),
  thumbnail_url: z.string().nullable(),
});

export const videoCollectionNeighborsSchema = z.object({
  previous: neighborItemSchema.nullable(),
  next: neighborItemSchema.nullable(),
});

const errorSchema = z.object({
  message: z.string(),
  statusCode: z.number(),
});

export const videoCollectionResponseSchema = z.object({
  success: z.literal(true),
  data: videoCollectionSummarySchema,
  message: z.string().optional(),
});

export const videoCollectionsListResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(videoCollectionSummarySchema),
});

export const videoCollectionEntriesResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(entrySchema),
});

export const messageResponseSchema = z.object({
  success: z.literal(true),
  message: z.string(),
});

export const errorResponseSchema = z.object({
  success: z.literal(false),
  error: errorSchema,
});
