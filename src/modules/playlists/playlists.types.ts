import { z } from "zod";

export interface Playlist {
  id: number;
  user_id: number;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  thumbnail_url?: string | null;
}

export interface PlaylistVideo {
  playlist_id: number;
  video_id: number;
  position: number;
  added_at: string;
}

export const createPlaylistSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
});

export const updatePlaylistSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).nullable().optional(),
});

export const addVideoToPlaylistSchema = z.object({
  video_id: z.number().int().positive(),
  position: z.number().int().min(0).optional(), // Auto-assign if not provided
});

export const reorderPlaylistSchema = z.object({
  videos: z.array(
    z.object({
      video_id: z.number().int().positive(),
      position: z.number().int().min(0),
    }),
  ),
});

export type CreatePlaylistInput = z.infer<typeof createPlaylistSchema>;
export type UpdatePlaylistInput = z.infer<typeof updatePlaylistSchema>;
export type AddVideoToPlaylistInput = z.infer<typeof addVideoToPlaylistSchema>;
export type ReorderPlaylistInput = z.infer<typeof reorderPlaylistSchema>;
