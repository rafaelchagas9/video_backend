import { pgTable, serial, text, integer, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { videosTable } from './videos.schema';

// Tagging rules table
export const taggingRulesTable = pgTable('tagging_rules', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  ruleType: text('rule_type').default('path_match').notNull(),
  isEnabled: boolean('is_enabled').default(true).notNull(),
  priority: integer('priority').default(0).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  enabledIdx: index('idx_tagging_rules_enabled').on(table.isEnabled),
  priorityIdx: index('idx_tagging_rules_priority').on(table.priority),
}));

// Rule conditions (what to match)
export const taggingRuleConditionsTable = pgTable('tagging_rule_conditions', {
  id: serial('id').primaryKey(),
  ruleId: integer('rule_id').notNull().references(() => taggingRulesTable.id, { onDelete: 'cascade' }),
  conditionType: text('condition_type').notNull(),
  operator: text('operator').notNull(),
  value: text('value').notNull(),
}, (table) => ({
  ruleIdx: index('idx_tagging_rule_conditions_rule').on(table.ruleId),
}));

// Rule actions (what to do when matched)
export const taggingRuleActionsTable = pgTable('tagging_rule_actions', {
  id: serial('id').primaryKey(),
  ruleId: integer('rule_id').notNull().references(() => taggingRulesTable.id, { onDelete: 'cascade' }),
  actionType: text('action_type').notNull(),
  targetId: integer('target_id'),
  targetName: text('target_name'),
  dynamicValue: text('dynamic_value'),
}, (table) => ({
  ruleIdx: index('idx_tagging_rule_actions_rule').on(table.ruleId),
}));

// Tagging rule execution log
export const taggingRuleLogTable = pgTable('tagging_rule_log', {
  id: serial('id').primaryKey(),
  ruleId: integer('rule_id').notNull().references(() => taggingRulesTable.id, { onDelete: 'cascade' }),
  videoId: integer('video_id').notNull().references(() => videosTable.id, { onDelete: 'cascade' }),
  appliedAt: timestamp('applied_at').defaultNow().notNull(),
  success: boolean('success').default(true).notNull(),
  errorMessage: text('error_message'),
}, (table) => ({
  videoIdx: index('idx_tagging_rule_log_video').on(table.videoId),
  ruleIdx: index('idx_tagging_rule_log_rule').on(table.ruleId),
  appliedIdx: index('idx_tagging_rule_log_applied').on(table.appliedAt),
}));

// Inferred types
export type TaggingRule = typeof taggingRulesTable.$inferSelect;
export type NewTaggingRule = typeof taggingRulesTable.$inferInsert;
export type TaggingRuleCondition = typeof taggingRuleConditionsTable.$inferSelect;
export type NewTaggingRuleCondition = typeof taggingRuleConditionsTable.$inferInsert;
export type TaggingRuleAction = typeof taggingRuleActionsTable.$inferSelect;
export type NewTaggingRuleAction = typeof taggingRuleActionsTable.$inferInsert;
export type TaggingRuleLog = typeof taggingRuleLogTable.$inferSelect;
export type NewTaggingRuleLog = typeof taggingRuleLogTable.$inferInsert;
