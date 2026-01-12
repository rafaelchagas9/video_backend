import { z } from "zod";

// Re-export from types for consistency
export {
  createCreatorSchema,
  updateCreatorSchema,
  createSocialLinkSchema,
  updateSocialLinkSchema
} from "./creators.types";
export {
  createCreatorPlatformSchema,
  updateCreatorPlatformSchema
} from "@/modules/platforms/platforms.types";

// Helper to parse comma-separated IDs
const parseCommaSeparatedIds = (val: unknown) => {
  if (typeof val === 'string' && val.trim().length > 0) {
    return val.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));
  }
  if (Array.isArray(val)) {
    return val;
  }
  return undefined;
};

// Request schemas
export const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export const listCreatorsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  search: z.string().optional(),
  sort: z.enum(['name', 'created_at', 'updated_at', 'video_count']).default('name'),
  order: z.enum(['asc', 'desc']).default('asc'),
  minVideoCount: z.coerce.number().int().min(0).optional(),
  maxVideoCount: z.coerce.number().int().min(0).optional(),
  hasProfilePicture: z.coerce.boolean().optional(),
  studioIds: z.preprocess(
    parseCommaSeparatedIds,
    z.array(z.number().int().positive()).optional()
  ).optional(),
  missing: z.enum(['picture', 'platform', 'social', 'linked', 'any']).optional(),
  complete: z.coerce.boolean().optional(),
}).refine(
  (data) => {
    if (data.minVideoCount !== undefined && data.maxVideoCount !== undefined && data.minVideoCount > data.maxVideoCount) {
      return false;
    }
    return true;
  },
  {
    message: "minVideoCount cannot be greater than maxVideoCount",
  }
);

// Completeness schema
const completenessSchema = z.object({
  is_complete: z.boolean(),
  missing_fields: z.array(z.string()),
});

// Response schemas - Enhanced creator with counts and completeness
const creatorSchema = z.object({
  id: z.number(),
  name: z.string(),
  description: z.string().nullable(),
  profile_picture_path: z.string().optional().nullable(),
  profile_picture_url: z.string().optional(),
  created_at: z.string(),
  updated_at: z.string(),
  // Enhanced fields
  platform_count: z.number().optional(),
  social_link_count: z.number().optional(),
  linked_video_count: z.number().optional(),
  has_profile_picture: z.boolean().optional(),
  completeness: completenessSchema.optional(),
});

const platformProfileSchema = z.object({
  id: z.number(),
  creator_id: z.number(),
  platform_id: z.number(),
  platform_name: z.string().optional(),
  username: z.string(),
  profile_url: z.string(),
  is_primary: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
});

const socialLinkSchema = z.object({
  id: z.number(),
  creator_id: z.number(),
  platform_name: z.string(),
  url: z.string(),
  created_at: z.string(),
});

const studioSchema = z.object({
  id: z.number(),
  name: z.string(),
  description: z.string().nullable(),
  profile_picture_path: z.string().nullable(),
  profile_picture_url: z.string().optional(),
  created_at: z.string(),
  updated_at: z.string(),
});

const videoSchema = z.object({
  id: z.number(),
  file_path: z.string(),
  file_name: z.string(),
  directory_id: z.number(),
  file_size_bytes: z.number(),
  duration_seconds: z.number().nullable(),
  title: z.string().nullable(),
  is_available: z.number(),
  created_at: z.string(),
});

const errorSchema = z.object({
  message: z.string(),
  statusCode: z.number(),
});

export const creatorResponseSchema = z.object({
  success: z.literal(true),
  data: creatorSchema,
  message: z.string().optional(),
});

export const creatorListResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(creatorSchema),
  pagination: z.object({
    page: z.number(),
    limit: z.number(),
    total: z.number(),
    totalPages: z.number(),
  }),
});

export const creatorVideosResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(videoSchema),
});

export const platformProfileResponseSchema = z.object({
  success: z.literal(true),
  data: platformProfileSchema,
  message: z.string().optional(),
});

export const platformProfileListResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(platformProfileSchema),
});

export const socialLinkResponseSchema = z.object({
  success: z.literal(true),
  data: socialLinkSchema,
  message: z.string().optional(),
});

export const socialLinkListResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(socialLinkSchema),
});

export const studioListResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(studioSchema),
});

export const messageResponseSchema = z.object({
  success: z.literal(true),
  message: z.string(),
});

export const errorResponseSchema = z.object({
  success: z.literal(false),
  error: errorSchema,
});

// Bulk operation schemas
export const bulkPlatformItemSchema = z.object({
  platform_id: z.number().int().positive(),
  username: z.string().min(1).max(100),
  profile_url: z.string().url(),
  is_primary: z.boolean().optional().default(false),
});

export const bulkPlatformsSchema = z.object({
  items: z.array(bulkPlatformItemSchema).min(1).max(50),
});

export const bulkSocialLinkItemSchema = z.object({
  platform_name: z.string().min(1).max(50),
  url: z.string().url(),
});

export const bulkSocialLinksSchema = z.object({
  items: z.array(bulkSocialLinkItemSchema).min(1).max(50),
});

export const pictureFromUrlSchema = z.object({
  url: z.string().url(),
});

export const bulkOperationResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    created: z.array(z.any()),
    updated: z.array(z.any()),
    errors: z.array(z.object({
      index: z.number(),
      error: z.string(),
    })),
  }),
  message: z.string().optional(),
});

// Bulk Import schemas
export const bulkImportQuerySchema = z.object({
  dry_run: z.coerce.boolean().optional().default(false),
});

export const bulkCreatorImportItemSchema = z.object({
  id: z.number().int().positive().optional(),
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  profile_picture_url: z.string().url().optional(),
  platforms: z.array(bulkPlatformItemSchema).optional(),
  social_links: z.array(bulkSocialLinkItemSchema).optional(),
  link_video_ids: z.array(z.number().int().positive()).optional(),
});

export const bulkCreatorImportSchema = z.object({
  items: z.array(bulkCreatorImportItemSchema).min(1).max(100),
  mode: z.enum(['merge', 'replace']).default('merge'),
});

export const bulkImportPreviewItemSchema = z.object({
  index: z.number(),
  action: z.enum(['create', 'update']),
  resolved_id: z.number().nullable(),
  name: z.string(),
  validation_errors: z.array(z.string()),
  changes: z.object({
    name: z.object({ from: z.string().nullable(), to: z.string() }).optional(),
    description: z.object({ from: z.string().nullable(), to: z.string().nullable() }).optional(),
    profile_picture: z.object({ action: z.enum(['set', 'unchanged']) }).optional(),
    platforms: z.object({ add: z.number(), update: z.number(), remove: z.number().optional() }).optional(),
    social_links: z.object({ add: z.number(), update: z.number(), remove: z.number().optional() }).optional(),
    videos: z.object({ add: z.number(), remove: z.number().optional() }).optional(),
  }),
  missing_dependencies: z.array(z.string()),
});

export const bulkImportResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    dry_run: z.boolean(),
    items: z.array(bulkImportPreviewItemSchema),
    summary: z.object({
      will_create: z.number(),
      will_update: z.number(),
      errors: z.number(),
    }),
  }),
  message: z.string().optional(),
});

