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

// Completeness tracking
export interface CompletenessInfo {
  is_complete: boolean;
  missing_fields: string[];
}

// Enhanced studio with counts and completeness
export interface EnhancedStudio extends Studio {
  social_link_count: number;
  linked_video_count: number;
  linked_creator_count: number;
  has_profile_picture: boolean;
  completeness: CompletenessInfo;
}

export interface ListStudiosOptions {
  page?: number;
  limit?: number;
  search?: string;
  sort?: 'name' | 'created_at' | 'updated_at' | 'video_count' | 'creator_count';
  order?: 'asc' | 'desc';
  missing?: 'picture' | 'social' | 'linked' | 'any';
  complete?: boolean;
}

export interface PaginatedStudios {
  data: EnhancedStudio[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
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

// Bulk operation types
export interface BulkStudioSocialLinkItem {
  platform_name: string;
  url: string;
}

export interface BulkOperationResult<T> {
  created: T[];
  updated: T[];
  errors: Array<{ index: number; error: string }>;
}

// Bulk Import types
export interface BulkStudioImportItem {
  id?: number;
  name: string;
  description?: string;
  profile_picture_url?: string;
  social_links?: BulkStudioSocialLinkItem[];
  link_creator_ids?: number[];
  link_video_ids?: number[];
}

export interface BulkStudioImportPreviewItem {
  index: number;
  action: 'create' | 'update';
  resolved_id: number | null;
  name: string;
  validation_errors: string[];
  changes: {
    name?: { from: string | null; to: string };
    description?: { from: string | null; to: string | null };
    profile_picture?: { action: 'set' | 'unchanged' };
    social_links?: { add: number; update: number; remove?: number };
    creators?: { add: number; remove?: number };
    videos?: { add: number; remove?: number };
  };
  missing_dependencies: string[];
}

export interface BulkStudioImportResult {
  success: boolean;
  dry_run: boolean;
  items: BulkStudioImportPreviewItem[];
  summary: {
    will_create: number;
    will_update: number;
    errors: number;
  };
}

