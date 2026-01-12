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

// Completeness tracking
export interface CompletenessInfo {
  is_complete: boolean;
  missing_fields: string[];
}

// Enhanced creator with counts and completeness
export interface EnhancedCreator extends Creator {
  platform_count: number;
  social_link_count: number;
  linked_video_count: number;
  has_profile_picture: boolean;
  completeness: CompletenessInfo;
}

export interface ListCreatorsOptions {
  page?: number;
  limit?: number;
  search?: string;
  sort?: 'name' | 'created_at' | 'updated_at' | 'video_count';
  order?: 'asc' | 'desc';
  minVideoCount?: number;
  maxVideoCount?: number;
  hasProfilePicture?: boolean;
  studioIds?: number[];
  missing?: 'picture' | 'platform' | 'social' | 'linked' | 'any';
  complete?: boolean;
}

export interface PaginatedCreators {
  data: EnhancedCreator[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

// Bulk operation types
export interface BulkPlatformItem {
  platform_id: number;
  username: string;
  profile_url: string;
  is_primary?: boolean;
}

export interface BulkSocialLinkItem {
  platform_name: string;
  url: string;
}

export interface BulkOperationResult<T> {
  created: T[];
  updated: T[];
  errors: Array<{ index: number; error: string }>;
}

// Bulk Import types
export interface BulkCreatorImportItem {
  id?: number; // If provided, will update existing; if not, will create new
  name: string;
  description?: string;
  profile_picture_url?: string;
  platforms?: BulkPlatformItem[];
  social_links?: BulkSocialLinkItem[];
  link_video_ids?: number[];
}

export interface BulkCreatorImportInput {
  items: BulkCreatorImportItem[];
  mode: 'merge' | 'replace';
}

export interface BulkImportPreviewItem {
  index: number;
  action: 'create' | 'update';
  resolved_id: number | null; // null if will create new
  name: string;
  validation_errors: string[];
  changes: {
    name?: { from: string | null; to: string };
    description?: { from: string | null; to: string | null };
    profile_picture?: { action: 'set' | 'unchanged' };
    platforms?: { add: number; update: number; remove?: number };
    social_links?: { add: number; update: number; remove?: number };
    videos?: { add: number; remove?: number };
  };
  missing_dependencies: string[];
}

export interface BulkImportResult {
  success: boolean;
  dry_run: boolean;
  items: BulkImportPreviewItem[];
  summary: {
    will_create: number;
    will_update: number;
    errors: number;
  };
}

