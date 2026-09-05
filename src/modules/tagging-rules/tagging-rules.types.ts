import type { z } from "zod";
import type {
  createTaggingRuleSchema,
  updateTaggingRuleSchema,
  testRuleSchema,
  applyRulesSchema,
} from "./tagging-rules.schemas";

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

export type CreateTaggingRuleInput = z.infer<typeof createTaggingRuleSchema>;
export type UpdateTaggingRuleInput = z.infer<typeof updateTaggingRuleSchema>;
export type TestRuleInput = z.infer<typeof testRuleSchema>;
export type ApplyRulesInput = z.infer<typeof applyRulesSchema>;
