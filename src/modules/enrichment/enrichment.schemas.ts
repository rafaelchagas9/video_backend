import { z } from "zod";

export const entityTypeEnum = z.enum(["creator", "studio", "scene", "tag"]);

export const entityParamSchema = z.object({
  entityType: entityTypeEnum,
  id: z.coerce.number().int().positive(),
});

export const enrichmentSourceEnum = z.enum(["theporndb", "stashdb"]);

export const runEnrichmentBodySchema = z
  .object({
    sources: z
      .array(enrichmentSourceEnum)
      .min(1)
      .max(2)
      .optional(),
    source: enrichmentSourceEnum.optional(),
    search_name: z.string().trim().min(1).max(255).optional(),
    limit: z.coerce.number().int().min(1).max(25).optional(),
  })
  .strict()
  .nullish();

export const suggestionIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export const suggestionStatusEnum = z.enum([
  "pending",
  "accepted",
  "rejected",
  "superseded",
]);

export const suggestionTypeEnum = z.enum([
  "image",
  "platform",
  "social",
  "bio",
  "alias",
  "field",
  "external_id",
  "performer",
  "studio",
  "tag",
  "category",
  "parent",
]);

export const listSuggestionsQuerySchema = z.object({
  entity_type: entityTypeEnum.optional(),
  entity_id: z.coerce.number().int().positive().optional(),
  status: suggestionStatusEnum.optional(),
  type: suggestionTypeEnum.optional(),
});

const suggestionSchema = z.object({
  id: z.number(),
  entity_type: z.string(),
  entity_id: z.number(),
  type: z.string(),
  field_key: z.string().nullable(),
  value: z.string(),
  source: z.string(),
  source_url: z.string().nullable(),
  confidence: z.number().nullable(),
  face_match_score: z.number().nullable(),
  cached_preview_path: z.string().nullable(),
  status: z.string(),
  dedup_hash: z.string(),
  raw: z.any().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

const runSchema = z.object({
  id: z.number(),
  entity_type: z.string(),
  entity_id: z.number(),
  status: z.string(),
  sources_used: z.any().nullable(),
  suggestion_count: z.number(),
  errors: z.any().nullable(),
  started_at: z.string(),
  finished_at: z.string().nullable(),
});

const errorSchema = z.object({
  message: z.string(),
  statusCode: z.number(),
});

export const errorResponseSchema = z.object({
  success: z.literal(false),
  error: errorSchema,
});

export const runResponseSchema = z.object({
  success: z.literal(true),
  data: runSchema,
  message: z.string().optional(),
});

export const runListResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(runSchema),
});

export const suggestionResponseSchema = z.object({
  success: z.literal(true),
  data: suggestionSchema,
  message: z.string().optional(),
});

export const suggestionListResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(suggestionSchema),
});
