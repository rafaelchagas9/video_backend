import { z } from 'zod';

export interface Favorite {
  user_id: number;
  video_id: number;
  added_at: string;
}

export const addFavoriteSchema = z.object({
  video_id: z.number().int().positive(),
});

export type AddFavoriteInput = z.infer<typeof addFavoriteSchema>;
