import { z } from "zod";

export interface TaggingRule {
  id: number;
  name: string;
  description: string | null;
  rule_type: "path_match" | "metadata_match" | "manual";
  is_enabled: boolean;
  priority: number;
  created_at: string;
  updated_at: string;
  conditions?: TaggingRuleCondition[];
  actions?: TaggingRuleAction[];
}

export interface TaggingRuleCondition {
  id: number;
  rule_id: number;
  condition_type:
    | "path_pattern"
    | "file_pattern"
    | "duration_range"
    | "resolution"
    | "codec"
    | "file_size";
  operator:
    | "matches"
    | "equals"
    | "contains"
    | "gt"
    | "lt"
    | "gte"
    | "lte"
    | "regex";
  value: string;
}

export interface TaggingRuleAction {
  id: number;
  rule_id: number;
  action_type:
    | "add_tag"
    | "remove_tag"
    | "add_creator"
    | "remove_creator"
    | "add_studio"
    | "remove_studio";
  target_id: number | null;
  target_name: string | null;
  dynamic_value: string | null;
}

export interface TaggingRuleLog {
  id: number;
  rule_id: number;
  video_id: number;
  applied_at: string;
  success: boolean;
  error_message: string | null;
}

export interface CreateRuleConditionInput {
  condition_type: TaggingRuleCondition["condition_type"];
  operator: TaggingRuleCondition["operator"];
  value: string;
}

export interface CreateRuleActionInput {
  action_type: TaggingRuleAction["action_type"];
  target_id?: number;
  target_name?: string;
  dynamic_value?: string;
}

export interface TestRuleResult {
  matched: number;
  sample_matches: Array<{
    video_id: number;
    file_path: string;
    file_name: string;
    matched_conditions: string[];
  }>;
}

export interface ApplyRulesResult {
  processed: number;
  tagged: number;
  errors: number;
  details: {
    tags_added: number;
    creators_added: number;
    studios_added: number;
  };
  log: Array<{
    video_id: number;
    rule_id: number;
    success: boolean;
    error?: string;
  }>;
}

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

export const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export const testRuleSchema = z.object({
  limit: z.coerce.number().int().positive().max(100).default(10),
});

export const applyRulesSchema = z.object({
  video_ids: z.array(z.number().int().positive()).optional(),
  dry_run: z.coerce.boolean().default(false),
  limit: z.coerce.number().int().positive().max(1000).default(100),
});

export const bulkDeleteSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1),
});

export type CreateTaggingRuleInput = z.infer<typeof createTaggingRuleSchema>;
export type UpdateTaggingRuleInput = z.infer<typeof updateTaggingRuleSchema>;
export type TestRuleInput = z.infer<typeof testRuleSchema>;
export type ApplyRulesInput = z.infer<typeof applyRulesSchema>;
