import { z } from 'zod';

export interface Platform {
  id: number;
  name: string;
  base_url: string | null;
  created_at: string;
}

export interface CreatorPlatform {
  id: number;
  creator_id: number;
  platform_id: number;
  platform_name?: string; // Joined from platforms table
  username: string;
  profile_url: string;
  is_primary: boolean;
  created_at: string;
  updated_at: string;
}

export const createPlatformSchema = z.object({
  name: z.string().min(1).max(100),
  base_url: z.string().url().optional(),
});

export const createCreatorPlatformSchema = z.object({
  platform_id: z.number().int().positive(),
  username: z.string().min(1).max(100),
  profile_url: z.string().url(),
  is_primary: z.boolean().default(false),
});

export const updateCreatorPlatformSchema = z.object({
  username: z.string().min(1).max(100).optional(),
  profile_url: z.string().url().optional(),
  is_primary: z.boolean().optional(),
});

export type CreatePlatformInput = z.infer<typeof createPlatformSchema>;
export type CreateCreatorPlatformInput = z.infer<typeof createCreatorPlatformSchema>;
export type UpdateCreatorPlatformInput = z.infer<typeof updateCreatorPlatformSchema>;
