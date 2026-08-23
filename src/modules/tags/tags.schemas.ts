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

const parseIncludes = (value: unknown) =>
  typeof value === "string"
    ? value.split(",").map((item) => item.trim()).filter(Boolean)
    : value;

export const tagIncludesQuerySchema = z.object({
  include: z
    .preprocess(
      parseIncludes,
      z.array(z.enum(["category", "aliases"]))
    )
    .default([]),
});

export const listTagsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  search: z.string().optional(),
  sort: z.enum(["name", "created_at", "video_count"]).default("name"),
  order: z.enum(["asc", "desc"]).default("asc"),
  tree: z.preprocess(parseBooleanQuery, z.boolean()).default(false),
  category_id: z.coerce.number().int().positive().optional(),
  include: tagIncludesQuerySchema.shape.include,
});

export const treeQuerySchema = z.object({
  tree: z.enum(["true", "false"]).optional().default("false"),
});

// Response schemas
const taxonomyAliasSchema = z.object({
  id: z.number(),
  name: z.string(),
  note: z.string().nullable(),
});

const tagCategorySchema = z.object({
  id: z.number(),
  name: z.string(),
  group: z.string().nullable(),
  description: z.string().nullable(),
});

export const tagSchema = z.object({
  id: z.number(),
  name: z.string(),
  parent_id: z.number().nullable(),
  description: z.string().nullable(),
  color: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  video_count: z.number().optional(),
  category: tagCategorySchema.nullable().optional(),
  aliases: z.array(taxonomyAliasSchema).optional(),
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
  duration_seconds: z.preprocess(parseNullableNumber, z.number().nullable()),
  thumbnail_id: z.number().nullable().optional(),
  thumbnail_url: z.string().nullable().optional(),
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

export const tagCategoriesResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(tagCategorySchema.extend({ tag_count: z.number().int().min(0) })),
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
