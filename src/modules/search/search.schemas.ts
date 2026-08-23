import { z } from "zod";
import { videoSchema } from "@/modules/videos/videos.schemas";
import { creatorSchema } from "@/modules/creators/creators.schemas";
import { studioSchema } from "@/modules/studios/studios.schemas";
import { tagSchema } from "@/modules/tags/tags.schemas";
import { videoCollectionSummarySchema } from "@/modules/video-collections/video-collections.schemas";
import { playlistSchema } from "@/modules/playlists/playlists.schemas";

export const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(255),
  limit: z.coerce.number().int().positive().max(50).default(8),
});

export const searchResponseSchema = z.object({
  videos: z.array(videoSchema),
  creators: z.array(creatorSchema),
  studios: z.array(studioSchema),
  tags: z.array(tagSchema),
  collections: z.array(videoCollectionSummarySchema),
  playlists: z.array(playlistSchema),
  totals: z.object({
    videos: z.number(),
    creators: z.number(),
    studios: z.number(),
    tags: z.number(),
    collections: z.number(),
    playlists: z.number(),
  }),
});

export const errorResponseSchema = z.object({
  success: z.literal(false),
  error: z.object({
    message: z.string(),
    statusCode: z.number(),
  }),
});
