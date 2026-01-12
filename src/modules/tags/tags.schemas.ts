import { z } from "zod";

// Re-export from types for consistency
export { createTagSchema, updateTagSchema } from "./tags.types";

// Request schemas
export const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export const treeQuerySchema = z.object({
  tree: z.enum(["true", "false"]).optional().default("false"),
});

// Response schemas
const tagSchema = z.object({
  id: z.number(),
  name: z.string(),
  parent_id: z.number().nullable(),
  description: z.string().nullable(),
  color: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

const tagWithPathSchema = tagSchema.extend({
  path: z.string(),
});

const tagTreeNodeSchema: z.ZodType<any> = z.lazy(() =>
  tagSchema.extend({
    children: z.array(tagTreeNodeSchema).optional(),
  }),
);

const videoSchema = z.object({
  id: z.number(),
  file_name: z.string(),
  title: z.string().nullable(),
  duration_seconds: z.number().nullable(),
});

const errorSchema = z.object({
  message: z.string(),
  statusCode: z.number(),
});

export const tagResponseSchema = z.object({
  success: z.literal(true),
  data: tagWithPathSchema,
  message: z.string().optional(),
});

export const tagRecordResponseSchema = z.object({
  success: z.literal(true),
  data: tagSchema,
  message: z.string().optional(),
});

export const tagListResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(tagSchema),
});

export const tagTreeResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(tagTreeNodeSchema),
});

export const tagVideosResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(videoSchema),
});

export const messageResponseSchema = z.object({
  success: z.literal(true),
  message: z.string(),
});

export const errorResponseSchema = z.object({
  success: z.literal(false),
  error: errorSchema,
});
