import { z } from 'zod';

export interface Rating {
  id: number;
  video_id: number;
  rating: number; // 1-5
  comment: string | null;
  rated_at: string;
}

export const createRatingSchema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().max(2000).optional(),
});

export const updateRatingSchema = z.object({
  rating: z.number().int().min(1).max(5).optional(),
  comment: z.string().max(2000).nullable().optional(),
});

export type CreateRatingInput = z.infer<typeof createRatingSchema>;
export type UpdateRatingInput = z.infer<typeof updateRatingSchema>;
