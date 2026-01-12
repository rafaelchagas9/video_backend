import { z } from 'zod';

export interface Storyboard {
  id: number;
  video_id: number;
  sprite_path: string;
  vtt_path: string;
  tile_width: number;
  tile_height: number;
  tile_count: number;
  interval_seconds: number;
  sprite_size_bytes: number | null;
  generated_at: string;
}

export const generateStoryboardSchema = z.object({
  tileWidth: z.number().min(64).max(512).optional(),
  tileHeight: z.number().min(36).max(288).optional(),
  intervalSeconds: z.number().min(1).max(60).optional(),
});

export type GenerateStoryboardInput = z.infer<typeof generateStoryboardSchema>;
