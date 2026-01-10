import { z } from 'zod';

export interface Thumbnail {
  id: number;
  video_id: number;
  file_path: string;
  file_size_bytes: number;
  timestamp_seconds: number;
  width: number;
  height: number;
  generated_at: string;
}

export const generateThumbnailSchema = z
  .object({
    timestamp: z.number().min(0).optional(), // Optional override (seconds)
    positionPercent: z.number().min(0).max(100).optional(), // Optional override (percentage)
  })
  .refine((data) => !(data.timestamp && data.positionPercent), {
    message: 'Cannot specify both timestamp and positionPercent',
  });

export type GenerateThumbnailInput = z.infer<typeof generateThumbnailSchema>;
