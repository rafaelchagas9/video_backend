import { z } from "zod";
import type { VideoArtworkSummary } from "@/modules/artwork/artwork.types";
import type { Creator } from "@/modules/creators/creators.types";
import type { Studio } from "@/modules/studios/studios.types";
import type { Tag } from "@/modules/tags/tags.types";

export type WatchHistoryInclude = "artwork" | "creators" | "tags" | "studios";

export interface VideoStats {
  user_id: number;
  video_id: number;
  play_count: number;
  total_watch_seconds: number;
  session_watch_seconds: number;
  session_play_counted: number;
  last_position_seconds: number | null;
  last_played_at: string | null;
  last_watch_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AggregateVideoStats {
  video_id: number;
  total_play_count: number;
  total_watch_seconds: number;
  last_played_at: string | null;
}

export interface WatchHistoryVideo {
  id: number;
  file_name: string;
  title: string | null;
  duration_seconds: number | null;
  thumbnail_id: number | null;
  thumbnail_url: string | null;
  artwork?: VideoArtworkSummary | null;
  creators?: Creator[];
  tags?: Tag[];
  studios?: Studio[];
}

export interface WatchHistoryEntry {
  video: WatchHistoryVideo;
  play_count: number;
  total_watch_seconds: number;
  last_position_seconds: number | null;
  last_played_at: string | null;
  last_watch_at: string;
}

export interface WatchHistoryResult {
  data: WatchHistoryEntry[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export const watchUpdateSchema = z.object({
  watched_seconds: z.number().positive(),
  last_position_seconds: z.number().nonnegative().optional(),
});

export const watchHistoryQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(24),
  include: z
    .preprocess(
      (value) =>
        typeof value === "string"
          ? value.split(",").map((item) => item.trim()).filter(Boolean)
          : value,
      z.array(z.enum(["artwork", "creators", "tags", "studios"])),
    )
    .default([]),
});

export type WatchUpdateInput = z.infer<typeof watchUpdateSchema>;
export type WatchHistoryQuery = z.infer<typeof watchHistoryQuerySchema>;
