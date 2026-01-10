import { z } from 'zod';

export interface Creator {
  id: number;
  name: string;
  description: string | null;
  profile_picture_path: string | null;
  profile_picture_url?: string; // Computed field
  created_at: string;
  updated_at: string;
}

export interface SocialLink {
  id: number;
  creator_id: number;
  platform_name: string;
  url: string;
  created_at: string;
}

export const createCreatorSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
});

export const updateCreatorSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).nullable().optional(),
});

export const createSocialLinkSchema = z.object({
  platform_name: z.string().min(1).max(50),
  url: z.string().url(),
});

export const updateSocialLinkSchema = z.object({
  platform_name: z.string().min(1).max(50).optional(),
  url: z.string().url().optional(),
});

export type CreateCreatorInput = z.infer<typeof createCreatorSchema>;
export type UpdateCreatorInput = z.infer<typeof updateCreatorSchema>;
export type CreateSocialLinkInput = z.infer<typeof createSocialLinkSchema>;
export type UpdateSocialLinkInput = z.infer<typeof updateSocialLinkSchema>;

export interface ListCreatorsOptions {
  page?: number;
  limit?: number;
  search?: string;
  sort?: string;
  order?: 'asc' | 'desc';
  minVideoCount?: number;
  maxVideoCount?: number;
  hasProfilePicture?: boolean;
  studioIds?: number[];
}

export interface PaginatedCreators {
  data: Creator[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}
