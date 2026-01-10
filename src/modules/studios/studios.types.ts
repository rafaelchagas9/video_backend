import { z } from 'zod';

export interface Studio {
  id: number;
  name: string;
  description: string | null;
  profile_picture_path: string | null;
  profile_picture_url?: string; // Computed field
  created_at: string;
  updated_at: string;
}

export interface StudioSocialLink {
  id: number;
  studio_id: number;
  platform_name: string;
  url: string;
  created_at: string;
}

export const createStudioSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
});

export const updateStudioSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).nullable().optional(),
});

export const createStudioSocialLinkSchema = z.object({
  platform_name: z.string().min(1).max(50),
  url: z.string().url(),
});

export const updateStudioSocialLinkSchema = z.object({
  platform_name: z.string().min(1).max(50).optional(),
  url: z.string().url().optional(),
});

export type CreateStudioInput = z.infer<typeof createStudioSchema>;
export type UpdateStudioInput = z.infer<typeof updateStudioSchema>;
export type CreateStudioSocialLinkInput = z.infer<typeof createStudioSocialLinkSchema>;
export type UpdateStudioSocialLinkInput = z.infer<typeof updateStudioSocialLinkSchema>;
