import { z } from 'zod';

export interface Bookmark {
  id: number;
  video_id: number;
  user_id: number;
  timestamp_seconds: number;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export const createBookmarkSchema = z.object({
  timestamp_seconds: z.number().min(0),
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
});

export const updateBookmarkSchema = z.object({
  timestamp_seconds: z.number().min(0).optional(),
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).nullable().optional(),
});

export type CreateBookmarkInput = z.infer<typeof createBookmarkSchema>;
export type UpdateBookmarkInput = z.infer<typeof updateBookmarkSchema>;
