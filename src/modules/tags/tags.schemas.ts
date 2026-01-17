import { z } from "zod";

// Re-export from types for consistency
export { createTagSchema, updateTagSchema } from "./tags.types";

// Request schemas
export const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
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

const parseBooleanQuery = (val: unknown) => {
  if (typeof val === "boolean") {
    return val;
  }
  if (typeof val === "string") {
    return val.toLowerCase() === "true";
  }
  return undefined;
};

export const listTagsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  search: z.string().optional(),
  sort: z.enum(["name", "created_at"]).default("name"),
  order: z.enum(["asc", "desc"]).default("asc"),
  tree: z.preprocess(parseBooleanQuery, z.boolean()).default(false),
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
    children: z.array(tagTreeNodeSchema),
  }),
);

const videoSchema = z.object({
  id: z.number(),
  file_name: z.string(),
  title: z.string().nullable(),
  duration_seconds: z.preprocess(parseNullableNumber, z.number().nullable()),
});

const errorSchema = z.object({
  message: z.string(),
  statusCode: z.number(),
});

const paginationSchema = z.object({
  page: z.number(),
  limit: z.number(),
  total: z.number(),
  totalPages: z.number(),
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
  data: z.array(tagTreeNodeSchema),
  pagination: paginationSchema,
});

export const tagSimpleListResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(tagSchema),
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
