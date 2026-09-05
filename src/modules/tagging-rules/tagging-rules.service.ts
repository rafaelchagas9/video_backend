import { db, type DrizzleTransaction } from "@/config/drizzle";
import { eq, and, inArray, sql, asc, isNull } from "drizzle-orm";
import {
  taggingRulesTable,
  taggingRuleConditionsTable,
  taggingRuleActionsTable,
  videoTagsTable,
  videoCreatorsTable,
  creatorsTable,
  tagsTable,
  studiosTable,
} from "@/database/schema";
import {
  NotFoundError,
  ConflictError,
  isUniqueViolation,
} from "@/utils/errors";
import { logger } from "@/utils/logger";
import { studioAssignmentService } from "@/modules/studios/studio-assignment.service";
import type {
  TaggingRule,
  TaggingRuleCondition,
  TaggingRuleAction,
  CreateTaggingRuleInput,
  UpdateTaggingRuleInput,
  TestRuleResult,
  ApplyRulesResult,
} from "./tagging-rules.types";
import { env } from "@/config/env";
import { compileConditions, type RuleVideo } from "./tagging-rules.matcher";
import { videosRelatedService } from "@/modules/videos/videos.related.service";
import { taggingRulesDemoService } from "./tagging-rules.demo.service";

export class TaggingRulesService {
  async list(includeDisabled: boolean = false): Promise<TaggingRule[]> {
    if (env.DEMO_MODE) return taggingRulesDemoService.list(includeDisabled);
    const whereConditions = [];
    if (!includeDisabled) {
      whereConditions.push(sql`is_enabled = true`);
    }

    const whereClause =
      whereConditions.length > 0
        ? sql`WHERE ${sql.join(whereConditions, sql` AND `)}`
        : sql``;

    const query = sql`
      SELECT * FROM tagging_rules
      ${whereClause}
      ORDER BY priority DESC, name ASC
    `;

    const rules = (await db.execute(query)) as any[];

    if (!rules.length) return [];
    const ids = rules.map((rule) => rule.id);
    const [conditions, actions] = await Promise.all([
      db
        .select()
        .from(taggingRuleConditionsTable)
        .where(inArray(taggingRuleConditionsTable.ruleId, ids))
        .orderBy(asc(taggingRuleConditionsTable.id)),
      db
        .select()
        .from(taggingRuleActionsTable)
        .where(inArray(taggingRuleActionsTable.ruleId, ids))
        .orderBy(asc(taggingRuleActionsTable.id)),
    ]);
    const byId = new Map(rules.map((rule) => [rule.id, rule]));
    for (const rule of rules) {
      rule.conditions = [];
      rule.actions = [];
    }
    for (const condition of conditions)
      byId
        .get(condition.ruleId)
        ?.conditions.push(this.mapConditionToSnakeCase(condition));
    for (const action of actions)
      byId.get(action.ruleId)?.actions.push(this.mapActionToSnakeCase(action));

    return rules.map((r) => this.mapRuleToSnakeCase(r));
  }

  async findById(id: number): Promise<TaggingRule> {
    if (env.DEMO_MODE) return taggingRulesDemoService.findById(id);
    const rules = await db
      .select()
      .from(taggingRulesTable)
      .where(eq(taggingRulesTable.id, id));

    if (rules.length === 0) {
      throw new NotFoundError(`Tagging rule not found with id: ${id}`);
    }

    const rule = rules[0];

    const conditions = await db
      .select()
      .from(taggingRuleConditionsTable)
      .where(eq(taggingRuleConditionsTable.ruleId, id));

    const actions = await db
      .select()
      .from(taggingRuleActionsTable)
      .where(eq(taggingRuleActionsTable.ruleId, id))
      .orderBy(asc(taggingRuleActionsTable.id));

    const mappedRule = this.mapRuleToSnakeCase(rule);
    mappedRule.conditions = conditions.map((c) =>
      this.mapConditionToSnakeCase(c)
    );
    mappedRule.actions = actions.map((a) => this.mapActionToSnakeCase(a));

    return mappedRule;
  }

  async create(input: CreateTaggingRuleInput): Promise<TaggingRule> {
    if (env.DEMO_MODE) return taggingRulesDemoService.create(input);
    const { conditions, actions, ...ruleData } = input;

    try {
      const ruleId = await db.transaction(async (tx) => {
        const result = await tx
          .insert(taggingRulesTable)
          .values({
            name: ruleData.name,
            description: ruleData.description || null,
            ruleType: ruleData.rule_type,
            isEnabled: ruleData.is_enabled ?? true,
            priority: ruleData.priority ?? 0,
          })
          .returning({ id: taggingRulesTable.id });

        const ruleId = result[0].id;

        // Insert conditions
        if (conditions && conditions.length > 0) {
          await tx.insert(taggingRuleConditionsTable).values(
            conditions.map((condition) => ({
              ruleId,
              conditionType: condition.condition_type,
              operator: condition.operator,
              value: condition.value,
            }))
          );
        }

        // Insert actions
        if (actions && actions.length > 0) {
          await tx.insert(taggingRuleActionsTable).values(
            actions.map((action) => ({
              ruleId,
              actionType: action.action_type,
              targetId: action.target_id ?? null,
              targetName: action.target_name ?? null,
              dynamicValue: action.dynamic_value ?? null,
            }))
          );
        }

        return ruleId;
      });
      return this.findById(ruleId);
    } catch (error: any) {
      if (isUniqueViolation(error)) {
        // Unique violation
        throw new ConflictError(
          `Tagging rule with name "${ruleData.name}" already exists`
        );
      }
      throw error;
    }
  }

  async update(
    id: number,
    input: UpdateTaggingRuleInput
  ): Promise<TaggingRule> {
    if (env.DEMO_MODE) return taggingRulesDemoService.update(id, input);
    await this.findById(id);

    const updates: any = {};

    if (input.name !== undefined) {
      updates.name = input.name;
    }

    if (input.description !== undefined) {
      updates.description = input.description;
    }

    if (input.rule_type !== undefined) {
      updates.ruleType = input.rule_type;
    }

    if (input.is_enabled !== undefined) {
      updates.isEnabled = input.is_enabled;
    }

    if (input.priority !== undefined) {
      updates.priority = input.priority;
    }

    const replacingChildren =
      input.conditions !== undefined || input.actions !== undefined;

    try {
      await db.transaction(async (tx) => {
        if (Object.keys(updates).length > 0 || replacingChildren) {
          updates.updatedAt = new Date();
          await tx
            .update(taggingRulesTable)
            .set(updates)
            .where(eq(taggingRulesTable.id, id));
        }

        // Replace child rows when the caller provides them. An empty array clears
        // the existing rows; an omitted key leaves them untouched.
        if (input.conditions !== undefined) {
          await tx
            .delete(taggingRuleConditionsTable)
            .where(eq(taggingRuleConditionsTable.ruleId, id));

          if (input.conditions.length > 0) {
            await tx.insert(taggingRuleConditionsTable).values(
              input.conditions.map((condition) => ({
                ruleId: id,
                conditionType: condition.condition_type,
                operator: condition.operator,
                value: condition.value,
              }))
            );
          }
        }

        if (input.actions !== undefined) {
          await tx
            .delete(taggingRuleActionsTable)
            .where(eq(taggingRuleActionsTable.ruleId, id));

          if (input.actions.length > 0) {
            await tx.insert(taggingRuleActionsTable).values(
              input.actions.map((action) => ({
                ruleId: id,
                actionType: action.action_type,
                targetId: action.target_id ?? null,
                targetName: action.target_name ?? null,
                dynamicValue: action.dynamic_value ?? null,
              }))
            );
          }
        }
      });
    } catch (error) {
      if (isUniqueViolation(error))
        throw new ConflictError(
          `Tagging rule with name "${input.name}" already exists`
        );
      throw error;
    }

    return this.findById(id);
  }

  async delete(id: number): Promise<void> {
    if (env.DEMO_MODE) return taggingRulesDemoService.delete(id);
    await this.findById(id);
    await db.delete(taggingRulesTable).where(eq(taggingRulesTable.id, id));
  }

  async bulkDelete(ids: number[]): Promise<{ deleted: number }> {
    if (env.DEMO_MODE) return taggingRulesDemoService.bulkDelete(ids);
    if (ids.length === 0) {
      return { deleted: 0 };
    }

    const deleted = await db
      .delete(taggingRulesTable)
      .where(inArray(taggingRulesTable.id, ids))
      .returning({ id: taggingRulesTable.id });
    return { deleted: deleted.length };
  }

  async testRule(ruleId: number, limit: number = 10): Promise<TestRuleResult> {
    if (env.DEMO_MODE) return taggingRulesDemoService.testRule(ruleId, limit);
    const rule = await this.findById(ruleId);

    const videosResult = await db.execute(sql`
      SELECT id, file_path, file_name, duration_seconds, file_size_bytes, width, height, codec
      FROM videos
      WHERE is_available = true
      ORDER BY id ASC
      LIMIT ${limit}
    `);
    const videos = videosResult as unknown as RuleVideo[];
    const evaluate = compileConditions(rule.conditions ?? []);

    let matched = 0;
    const sampleMatches: TestRuleResult["sample_matches"] = [];

    for (const video of videos) {
      const { matchedConditions } = evaluate(video);

      if (matchedConditions.length > 0) {
        matched++;
        if (sampleMatches.length < limit) {
          sampleMatches.push({
            video_id: video.id,
            file_path: video.file_path,
            file_name: video.file_name,
            matched_conditions: matchedConditions,
          });
        }
      }
    }

    return {
      matched,
      sample_matches: sampleMatches,
    };
  }

  async applyRules(input: {
    video_ids?: number[];
    dry_run?: boolean;
    limit?: number;
  }): Promise<ApplyRulesResult> {
    if (env.DEMO_MODE) return taggingRulesDemoService.applyRules(input);
    const { video_ids, dry_run = false, limit = 100 } = input;

    const rules = await this.list(false);
    if (rules.length === 0 || video_ids?.length === 0) {
      return {
        processed: 0,
        tagged: 0,
        errors: 0,
        details: { tags_added: 0, creators_added: 0, studios_added: 0 },
        log: [],
      };
    }

    const videos = (await db.execute(sql`
      SELECT id, file_path, file_name, duration_seconds, file_size_bytes, width, height, codec
      FROM videos WHERE is_available = true
      ${
        video_ids
          ? sql`AND id IN (${sql.join(
              video_ids.map((id) => sql`${id}`),
              sql`, `
            )})`
          : sql``
      }
      ORDER BY id ASC LIMIT ${limit}
    `)) as unknown as RuleVideo[];
    const evaluators = new Map(
      rules.map((rule) => [rule.id, compileConditions(rule.conditions ?? [])])
    );

    let processed = 0;
    let tagged = 0;
    let errors = 0;
    let tagsAdded = 0;
    let creatorsAdded = 0;
    let studiosAdded = 0;
    const log: ApplyRulesResult["log"] = [];

    for (const video of videos) {
      processed++;

      let videoChanged = false;
      for (const rule of rules) {
        const conditions = rule.conditions || [];
        const actions = rule.actions || [];

        if (conditions.length === 0 || actions.length === 0) {
          continue;
        }

        const { matchedConditions, captures } = evaluators.get(rule.id)!(video);

        if (matchedConditions.length > 0) {
          if (dry_run) {
            videoChanged = true;
            log.push({
              video_id: video.id,
              rule_id: rule.id,
              success: true,
            });
          } else {
            try {
              const changes = await db.transaction(async (tx) => {
                const counts = {
                  changed: false,
                  tags: 0,
                  creators: 0,
                  studios: 0,
                };
                for (const action of actions) {
                  if (await this.applyAction(video.id, action, captures, tx)) {
                    counts.changed = true;
                    if (action.action_type === "add_tag") counts.tags++;
                    if (action.action_type === "add_creator") counts.creators++;
                    if (action.action_type === "add_studio") counts.studios++;
                  }
                }
                if (counts.changed)
                  await videosRelatedService.invalidateForVideos(
                    [video.id],
                    tx
                  );
                return counts;
              });
              videoChanged ||= changes.changed;
              tagsAdded += changes.tags;
              creatorsAdded += changes.creators;
              studiosAdded += changes.studios;
              log.push({
                video_id: video.id,
                rule_id: rule.id,
                success: true,
              });
            } catch (error: any) {
              errors++;
              log.push({
                video_id: video.id,
                rule_id: rule.id,
                success: false,
                error: error.message,
              });
              logger.warn(
                { error, video_id: video.id, rule_id: rule.id },
                "Failed to apply tagging rule"
              );
            }
          }
        }
      }
      if (videoChanged) tagged++;
    }

    return {
      processed,
      tagged,
      errors,
      details: {
        tags_added: tagsAdded,
        creators_added: creatorsAdded,
        studios_added: studiosAdded,
      },
      log,
    };
  }

  private async applyAction(
    videoId: number,
    action: TaggingRuleAction,
    captures: Record<string, string>,
    tx: DrizzleTransaction
  ): Promise<boolean> {
    const kind = action.action_type.endsWith("tag")
      ? "tag"
      : action.action_type.endsWith("creator")
        ? "creator"
        : "studio";
    const add = action.action_type.startsWith("add_");
    let targetId = action.target_id;
    const name = action.dynamic_value
      ? captures[action.dynamic_value.slice(1)]?.trim()
      : action.target_name?.trim();
    if (!targetId && name) {
      if (kind === "tag") {
        // Tags may repeat under different parents. A name-only action addresses
        // the root tag, and serializes concurrent rule-created root tags.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${"tagging-root-tag:" + name}))`
        );
        const [existing] = await tx
          .select({ id: tagsTable.id })
          .from(tagsTable)
          .where(and(eq(tagsTable.name, name), isNull(tagsTable.parentId)))
          .orderBy(asc(tagsTable.id))
          .limit(1);
        targetId = existing?.id ?? null;
        if (!targetId && add) {
          const [created] = await tx
            .insert(tagsTable)
            .values({ name })
            .returning({ id: tagsTable.id });
          targetId = created.id;
        }
      } else {
        const table = kind === "creator" ? creatorsTable : studiosTable;
        if (add) {
          const [row] = await tx
            .insert(table)
            .values({ name })
            .onConflictDoUpdate({ target: table.name, set: { name } })
            .returning({ id: table.id });
          targetId = row.id;
        } else {
          const [row] = await tx
            .select({ id: table.id })
            .from(table)
            .where(eq(table.name, name));
          targetId = row?.id ?? null;
        }
      }
      if (!targetId && !add) return false;
    }
    if (!targetId)
      throw new Error(`No target resolved for ${action.action_type}`);
    if (kind === "studio") {
      return (
        (add
          ? await studioAssignmentService.linkMany([videoId], [targetId], tx)
          : await studioAssignmentService.unlinkMany(
              [videoId],
              [targetId],
              tx
            )) > 0
      );
    }
    if (kind === "tag") {
      const rows = add
        ? await tx
            .insert(videoTagsTable)
            .values({ videoId, tagId: targetId })
            .onConflictDoNothing()
            .returning()
        : await tx
            .delete(videoTagsTable)
            .where(
              and(
                eq(videoTagsTable.videoId, videoId),
                eq(videoTagsTable.tagId, targetId)
              )
            )
            .returning();
      return rows.length > 0;
    }
    const rows = add
      ? await tx
          .insert(videoCreatorsTable)
          .values({ videoId, creatorId: targetId })
          .onConflictDoNothing()
          .returning()
      : await tx
          .delete(videoCreatorsTable)
          .where(
            and(
              eq(videoCreatorsTable.videoId, videoId),
              eq(videoCreatorsTable.creatorId, targetId)
            )
          )
          .returning();
    return rows.length > 0;
  }

  private mapRuleToSnakeCase(rule: any): TaggingRule {
    return {
      id: rule.id,
      name: rule.name,
      description: rule.description,
      rule_type: rule.ruleType || rule.rule_type,
      is_enabled: rule.isEnabled ?? rule.is_enabled,
      priority: rule.priority,
      created_at:
        rule.createdAt instanceof Date
          ? rule.createdAt.toISOString()
          : rule.created_at,
      updated_at:
        rule.updatedAt instanceof Date
          ? rule.updatedAt.toISOString()
          : rule.updated_at,
      conditions: rule.conditions || [],
      actions: rule.actions || [],
    };
  }

  private mapConditionToSnakeCase(condition: any): TaggingRuleCondition {
    return {
      id: condition.id,
      rule_id: condition.ruleId || condition.rule_id,
      condition_type: condition.conditionType || condition.condition_type,
      operator: condition.operator,
      value: condition.value,
    };
  }

  private mapActionToSnakeCase(action: any): TaggingRuleAction {
    return {
      id: action.id,
      rule_id: action.ruleId || action.rule_id,
      action_type: action.actionType || action.action_type,
      target_id: action.targetId ?? action.target_id ?? null,
      target_name: action.targetName ?? action.target_name ?? null,
      dynamic_value: action.dynamicValue ?? action.dynamic_value ?? null,
    };
  }
}

export const taggingRulesService = new TaggingRulesService();
