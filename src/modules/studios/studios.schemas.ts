import { z } from "zod";

// Re-export from types for consistency
export {
  createStudioSchema,
  updateStudioSchema,
  createStudioSocialLinkSchema,
  updateStudioSocialLinkSchema
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

// Response schemas
const studioSchema = z.object({
  id: z.number(),
  name: z.string(),
  description: z.string().nullable(),
  profile_picture_path: z.string().nullable(),
  profile_picture_url: z.string().optional(),
  created_at: z.string(),
  updated_at: z.string(),
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
  duration_seconds: z.number().nullable(),
  title: z.string().nullable(),
  is_available: z.number(),
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
  action: z.enum(['add', 'remove']),
});
