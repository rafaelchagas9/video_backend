import { z } from 'zod';

export const createDirectorySchema = z.object({
  path: z.string().min(1),
  auto_scan: z.boolean().default(true),
  scan_interval_minutes: z.number().int().positive().default(30),
});

export const updateDirectorySchema = z.object({
  is_active: z.boolean().optional(),
  auto_scan: z.boolean().optional(),
  scan_interval_minutes: z.number().int().positive().optional(),
});

export type CreateDirectoryInput = z.infer<typeof createDirectorySchema>;
export type UpdateDirectoryInput = z.infer<typeof updateDirectorySchema>;

export interface Directory {
  id: number;
  path: string;
  is_active: number;
  auto_scan: number;
  scan_interval_minutes: number;
  last_scan_at: string | null;
  added_at: string;
  updated_at: string;
}

export interface DirectoryStats {
  directory_id: number;
  total_videos: number;
  total_size_bytes: number;
  available_videos: number;
  unavailable_videos: number;
}
