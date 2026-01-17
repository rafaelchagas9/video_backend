import { z } from "zod";

const errorSchema = z.object({
  message: z.string(),
  statusCode: z.number(),
});

export const errorResponseSchema = z.object({
  success: z.literal(false),
  error: errorSchema,
});

const taggingRuleSchema = z.object({
  id: z.number(),
  name: z.string(),
  description: z.string().nullable(),
  rule_type: z.enum(["path_match", "metadata_match", "manual"]),
  is_enabled: z.boolean(),
  priority: z.number(),
  created_at: z.string(),
  updated_at: z.string(),
  conditions: z
    .array(
      z.object({
        id: z.number(),
        rule_id: z.number(),
        condition_type: z.enum([
          "path_pattern",
          "file_pattern",
          "duration_range",
          "resolution",
          "codec",
          "file_size",
        ]),
        operator: z.enum([
          "matches",
          "equals",
          "contains",
          "gt",
          "lt",
          "gte",
          "lte",
          "regex",
        ]),
        value: z.string(),
      }),
    )
    .optional(),
  actions: z
    .array(
      z.object({
        id: z.number(),
        rule_id: z.number(),
        action_type: z.enum([
          "add_tag",
          "remove_tag",
          "add_creator",
          "remove_creator",
          "add_studio",
          "remove_studio",
        ]),
        target_id: z.number().nullable(),
        target_name: z.string().nullable(),
        dynamic_value: z.string().nullable(),
      }),
    )
    .optional(),
});

export const taggingRuleResponseSchema = z.object({
  success: z.literal(true),
  data: taggingRuleSchema,
  message: z.string().optional(),
});

export const taggingRuleListResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(taggingRuleSchema),
});

export const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export const listQuerySchema = z.object({
  include_disabled: z.coerce.boolean().optional().default(false),
});

export const createTaggingRuleSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  rule_type: z.enum(["path_match", "metadata_match", "manual"]),
  is_enabled: z.boolean().default(true),
  priority: z.number().int().default(0),
  conditions: z
    .array(
      z.object({
        condition_type: z.enum([
          "path_pattern",
          "file_pattern",
          "duration_range",
          "resolution",
          "codec",
          "file_size",
        ]),
        operator: z.enum([
          "matches",
          "equals",
          "contains",
          "gt",
          "lt",
          "gte",
          "lte",
          "regex",
        ]),
        value: z.string().min(1).max(1000),
      }),
    )
    .optional(),
  actions: z
    .array(
      z.object({
        action_type: z.enum([
          "add_tag",
          "remove_tag",
          "add_creator",
          "remove_creator",
          "add_studio",
          "remove_studio",
        ]),
        target_id: z.number().int().positive().optional(),
        target_name: z.string().optional(),
        dynamic_value: z.string().optional(),
      }),
    )
    .min(1)
    .optional(),
});

export const updateTaggingRuleSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).nullable().optional(),
  rule_type: z.enum(["path_match", "metadata_match", "manual"]).optional(),
  is_enabled: z.boolean().optional(),
  priority: z.number().int().optional(),
});

export const bulkDeleteSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1),
});

export const bulkDeleteResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    deleted: z.number(),
  }),
  message: z.string(),
});

export const testRuleSchema = z.object({
  limit: z.coerce.number().int().positive().max(100).default(10),
});

export const testRuleResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    matched: z.number(),
    sample_matches: z.array(
      z.object({
        video_id: z.number(),
        file_path: z.string(),
        file_name: z.string(),
        matched_conditions: z.array(z.string()),
      }),
    ),
  }),
});

export const applyRulesSchema = z.object({
  video_ids: z.array(z.number().int().positive()).optional(),
  dry_run: z.coerce.boolean().default(false),
  limit: z.coerce.number().int().positive().max(1000).default(100),
});

export const applyRulesResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    processed: z.number(),
    tagged: z.number(),
    errors: z.number(),
    details: z.object({
      tags_added: z.number(),
      creators_added: z.number(),
      studios_added: z.number(),
    }),
  }),
});

export const messageResponseSchema = z.object({
  success: z.literal(true),
  message: z.string(),
});
