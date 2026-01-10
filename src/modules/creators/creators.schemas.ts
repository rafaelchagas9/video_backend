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
  sort: z.enum(['name', 'created_at', 'video_count']).default('name'),
  order: z.enum(['asc', 'desc']).default('asc'),
  minVideoCount: z.coerce.number().int().min(0).optional(),
  maxVideoCount: z.coerce.number().int().min(0).optional(),
  hasProfilePicture: z.coerce.boolean().optional(),
  studioIds: z.preprocess(
    parseCommaSeparatedIds,
    z.array(z.number().int().positive()).optional()
  ).optional(),
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

// Response schemas
const creatorSchema = z.object({
  id: z.number(),
  name: z.string(),
  description: z.string().nullable(),
  profile_picture_path: z.string().optional().nullable(),
  profile_picture_url: z.string().optional(),
  created_at: z.string(),
  updated_at: z.string(),
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
