import { z } from "zod";

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

export const watchUpdateSchema = z.object({
  watched_seconds: z.number().positive(),
  last_position_seconds: z.number().nonnegative().optional(),
});

export type WatchUpdateInput = z.infer<typeof watchUpdateSchema>;
