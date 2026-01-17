import { z } from "zod";

// Re-export from types for consistency
export {
  createStudioSchema,
  updateStudioSchema,
  createStudioSocialLinkSchema,
  updateStudioSocialLinkSchema,
} from "./studios.types";

// Request schemas
export const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export const creatorIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
  creatorId: z.coerce.number().int().positive(),
});

export const videoIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
  videoId: z.coerce.number().int().positive(),
});

export const linkIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
  linkId: z.coerce.number().int().positive(),
});

const parseNullableNumber = (val: unknown) => {
  if (val === null || val === undefined) {
    return null;
  }
  if (typeof val === "number") {
    return val;
  }
  if (typeof val === "string" && val.trim() !== "") {
    const parsed = Number.parseFloat(val);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
};

export const listStudiosQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  search: z.string().optional(),
  sort: z
    .enum(["name", "created_at", "updated_at", "video_count", "creator_count"])
    .default("name"),
  order: z.enum(["asc", "desc"]).default("asc"),
  missing: z.enum(["picture", "social", "linked", "any"]).optional(),
  complete: z.coerce.boolean().optional(),
});

// Completeness schema
const completenessSchema = z.object({
  is_complete: z.boolean(),
  missing_fields: z.array(z.string()),
});

// Response schemas - Enhanced studio with counts and completeness
const studioSchema = z.object({
  id: z.number(),
  name: z.string(),
  description: z.string().nullable(),
  profile_picture_path: z.string().nullable(),
  profile_picture_url: z.string().optional(),
  created_at: z.string(),
  updated_at: z.string(),
  // Enhanced fields
  social_link_count: z.number().optional(),
  linked_video_count: z.number().optional(),
  linked_creator_count: z.number().optional(),
  has_profile_picture: z.boolean().optional(),
  completeness: completenessSchema.optional(),
});

const creatorSchema = z.object({
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
  duration_seconds: z.preprocess(parseNullableNumber, z.number().nullable()),
  title: z.string().nullable(),
  is_available: z.boolean(),
  created_at: z.string(),
  thumbnail_id: z.number().nullable().optional(),
  thumbnail_url: z.string().nullable().optional(),
});

const socialLinkSchema = z.object({
  id: z.number(),
  studio_id: z.number(),
  platform_name: z.string(),
  url: z.string(),
  created_at: z.string(),
});

const errorSchema = z.object({
  message: z.string(),
  statusCode: z.number(),
});

export const studioResponseSchema = z.object({
  success: z.literal(true),
  data: studioSchema,
  message: z.string().optional(),
});

export const studioListResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(studioSchema),
  pagination: z
    .object({
      page: z.number(),
      limit: z.number(),
      total: z.number(),
      totalPages: z.number(),
    })
    .optional(),
});

export const creatorListResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(creatorSchema),
});

export const videoListResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(videoSchema),
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

export const messageResponseSchema = z.object({
  success: z.literal(true),
  message: z.string(),
});

export const errorResponseSchema = z.object({
  success: z.literal(false),
  error: errorSchema,
});

export const bulkUpdateCreatorsSchema = z.object({
  creatorIds: z.array(z.number().int().positive()).min(1),
  action: z.enum(["add", "remove"]),
});

// Bulk social links schema
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
    errors: z.array(
      z.object({
        index: z.number(),
        error: z.string(),
      }),
    ),
  }),
  message: z.string().optional(),
});

// Bulk Import schemas
export const bulkImportQuerySchema = z.object({
  dry_run: z.coerce.boolean().optional().default(false),
});

export const bulkStudioImportItemSchema = z.object({
  id: z.number().int().positive().optional(),
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  profile_picture_url: z.string().url().optional(),
  social_links: z.array(bulkSocialLinkItemSchema).optional(),
  link_creator_ids: z.array(z.number().int().positive()).optional(),
  link_video_ids: z.array(z.number().int().positive()).optional(),
});

export const bulkStudioImportSchema = z.object({
  items: z.array(bulkStudioImportItemSchema).min(1).max(100),
  mode: z.enum(["merge", "replace"]).default("merge"),
});

export const bulkStudioImportPreviewItemSchema = z.object({
  index: z.number(),
  action: z.enum(["create", "update"]),
  resolved_id: z.number().nullable(),
  name: z.string(),
  validation_errors: z.array(z.string()),
  changes: z.object({
    name: z.object({ from: z.string().nullable(), to: z.string() }).optional(),
    description: z
      .object({ from: z.string().nullable(), to: z.string().nullable() })
      .optional(),
    profile_picture: z
      .object({ action: z.enum(["set", "unchanged"]) })
      .optional(),
    social_links: z
      .object({
        add: z.number(),
        update: z.number(),
        remove: z.number().optional(),
      })
      .optional(),
    creators: z
      .object({ add: z.number(), remove: z.number().optional() })
      .optional(),
    videos: z
      .object({ add: z.number(), remove: z.number().optional() })
      .optional(),
  }),
  missing_dependencies: z.array(z.string()),
});

export const bulkStudioImportResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    dry_run: z.boolean(),
    items: z.array(bulkStudioImportPreviewItemSchema),
    summary: z.object({
      will_create: z.number(),
      will_update: z.number(),
      errors: z.number(),
    }),
  }),
  message: z.string().optional(),
});

// Autocomplete schemas
export const autocompleteQuerySchema = z.object({
  q: z.string().min(1).max(100),
  limit: z.coerce.number().int().positive().max(50).default(10),
});

export const autocompleteResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(studioSchema),
});

// Recent studios schemas
export const recentQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(50).default(10),
});

export const recentResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(studioSchema),
});

// Quick create schemas
export const quickCreateStudioSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
});

export const quickCreateResponseSchema = z.object({
  success: z.literal(true),
  data: studioSchema,
  message: z.string(),
});
