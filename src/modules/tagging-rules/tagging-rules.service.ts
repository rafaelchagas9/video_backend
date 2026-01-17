import { db } from "@/config/drizzle";
import { eq, and, sql } from "drizzle-orm";
import {
  taggingRulesTable,
  taggingRuleConditionsTable,
  taggingRuleActionsTable,
  videoTagsTable,
  videoCreatorsTable,
  videoStudiosTable,
  creatorsTable,
  studiosTable,
} from "@/database/schema";
import { NotFoundError, ConflictError } from "@/utils/errors";
import { logger } from "@/utils/logger";
import type {
  TaggingRule,
  TaggingRuleCondition,
  TaggingRuleAction,
  CreateTaggingRuleInput,
  UpdateTaggingRuleInput,
  TestRuleResult,
  ApplyRulesResult,
} from "./tagging-rules.types";

export class TaggingRulesService {
  async list(includeDisabled: boolean = false): Promise<TaggingRule[]> {
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

    // Load conditions and actions for each rule
    for (const rule of rules) {
      const conditions = await db
        .select()
        .from(taggingRuleConditionsTable)
        .where(eq(taggingRuleConditionsTable.ruleId, rule.id));

      const actions = await db
        .select()
        .from(taggingRuleActionsTable)
        .where(eq(taggingRuleActionsTable.ruleId, rule.id));

      rule.conditions = conditions.map((c) => this.mapConditionToSnakeCase(c));
      rule.actions = actions.map((a) => this.mapActionToSnakeCase(a));
    }

    return rules.map((r) => this.mapRuleToSnakeCase(r));
  }

  async findById(id: number): Promise<TaggingRule> {
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
      .where(eq(taggingRuleActionsTable.ruleId, id));

    const mappedRule = this.mapRuleToSnakeCase(rule);
    mappedRule.conditions = conditions.map((c) =>
      this.mapConditionToSnakeCase(c),
    );
    mappedRule.actions = actions.map((a) => this.mapActionToSnakeCase(a));

    return mappedRule;
  }

  async create(input: CreateTaggingRuleInput): Promise<TaggingRule> {
    const { conditions, actions, ...ruleData } = input;

    try {
      const result = await db
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
        await db.insert(taggingRuleConditionsTable).values(
          conditions.map((condition) => ({
            ruleId,
            conditionType: condition.condition_type,
            operator: condition.operator,
            value: condition.value,
          })),
        );
      }

      // Insert actions
      if (actions && actions.length > 0) {
        await db.insert(taggingRuleActionsTable).values(
          actions.map((action) => ({
            ruleId,
            actionType: action.action_type,
            targetId: action.target_id ?? null,
            targetName: action.target_name ?? null,
            dynamicValue: action.dynamic_value ?? null,
          })),
        );
      }

      return this.findById(ruleId);
    } catch (error: any) {
      if (error.code === "23505") {
        // Unique violation
        throw new ConflictError(
          `Tagging rule with name "${ruleData.name}" already exists`,
        );
      }
      throw error;
    }
  }

  async update(
    id: number,
    input: UpdateTaggingRuleInput,
  ): Promise<TaggingRule> {
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

    if (Object.keys(updates).length > 0) {
      updates.updatedAt = new Date();
      await db
        .update(taggingRulesTable)
        .set(updates)
        .where(eq(taggingRulesTable.id, id));
    }

    return this.findById(id);
  }

  async delete(id: number): Promise<void> {
    await this.findById(id);
    await db.delete(taggingRulesTable).where(eq(taggingRulesTable.id, id));
  }

  async bulkDelete(ids: number[]): Promise<{ deleted: number }> {
    if (ids.length === 0) {
      return { deleted: 0 };
    }

    await db.execute(sql`DELETE FROM tagging_rules WHERE id = ANY(${ids})`);
    // We can't easily get rowCount, so we just return the count of IDs passed
    return { deleted: ids.length };
  }

  async testRule(ruleId: number, limit: number = 10): Promise<TestRuleResult> {
    const rule = await this.findById(ruleId);

    const videosResult = await db.execute(sql`
      SELECT id, file_path, file_name
      FROM videos
      WHERE is_available = true
      ORDER BY id ASC
      LIMIT ${limit}
    `);
    const videos = videosResult as any[];

    let matched = 0;
    const sampleMatches: TestRuleResult["sample_matches"] = [];

    for (const video of videos) {
      const matchedConditions = this.evaluateConditions(
        video,
        rule.conditions || [],
      );

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
    const { video_ids, dry_run = false, limit = 100 } = input;

    const rules = await this.list(false);
    if (rules.length === 0) {
      return {
        processed: 0,
        tagged: 0,
        errors: 0,
        details: { tags_added: 0, creators_added: 0, studios_added: 0 },
        log: [],
      };
    }

    let videos: any[];
    if (video_ids && video_ids.length > 0) {
      const videosResult = await db.execute(
        sql`SELECT id, file_path, file_name FROM videos WHERE id = ANY(${video_ids})`,
      );
      videos = videosResult as any[];
    } else {
      const videosResult = await db.execute(sql`
        SELECT id, file_path, file_name FROM videos
        WHERE is_available = true
        ORDER BY id ASC
        LIMIT ${limit}
      `);
      videos = videosResult as any[];
    }

    let processed = 0;
    let tagged = 0;
    let errors = 0;
    let tagsAdded = 0;
    let creatorsAdded = 0;
    let studiosAdded = 0;
    const log: ApplyRulesResult["log"] = [];

    for (const video of videos) {
      processed++;

      for (const rule of rules) {
        const conditions = rule.conditions || [];
        const actions = rule.actions || [];

        if (conditions.length === 0 || actions.length === 0) {
          continue;
        }

        const matchedConditions = this.evaluateConditions(video, conditions);

        if (matchedConditions.length > 0) {
          if (dry_run) {
            tagged++;
            log.push({
              video_id: video.id,
              rule_id: rule.id,
              success: true,
            });
          } else {
            try {
              for (const action of actions) {
                const result = await this.applyAction(
                  video.id,
                  action,
                  video.file_path,
                );
                if (result.success) {
                  tagged++;
                  if (action.action_type === "add_tag") tagsAdded++;
                  if (action.action_type === "add_creator") creatorsAdded++;
                  if (action.action_type === "add_studio") studiosAdded++;
                }
              }
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
                "Failed to apply tagging rule",
              );
            }
          }
        }
      }
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

  private evaluateConditions(
    video: { id: number; file_path: string; file_name: string },
    conditions: TaggingRuleCondition[],
  ): string[] {
    const matched: string[] = [];

    for (const condition of conditions) {
      let matches = false;

      switch (condition.condition_type) {
        case "path_pattern":
        case "file_pattern":
          matches = this.matchPattern(
            video.file_path,
            condition.operator,
            condition.value,
          );
          break;
        case "resolution":
          matches = this.matchResolution(
            video.file_path,
            condition.operator,
            condition.value,
          );
          break;
        case "codec":
          matches = this.matchCodec(
            video.file_path,
            condition.operator,
            condition.value,
          );
          break;
        case "duration_range":
          matches = this.matchDuration(
            video.file_path,
            condition.operator,
            condition.value,
          );
          break;
        case "file_size":
          matches = this.matchFileSize(
            video.file_path,
            condition.operator,
            condition.value,
          );
          break;
      }

      if (matches) {
        matched.push(
          `${condition.condition_type} ${condition.operator} ${condition.value}`,
        );
      }
    }

    return matched;
  }

  private matchPattern(
    filePath: string,
    operator: string,
    value: string,
  ): boolean {
    try {
      const regex = new RegExp(value);
      const result = regex.test(filePath);
      return operator === "matches" ? result : !result;
    } catch {
      return false;
    }
  }

  private matchResolution(
    filePath: string,
    operator: string,
    value: string,
  ): boolean {
    const match = filePath.match(/(\d{3,4})x(\d{3,4})/i);
    if (!match) return false;

    const width = parseInt(match[1]);
    const height = parseInt(match[2]);

    const targetResolutions: Record<string, { width: number; height: number }> =
      {
        "4K": { width: 3840, height: 2160 },
        "1080p": { width: 1920, height: 1080 },
        "720p": { width: 1280, height: 720 },
        "480p": { width: 854, height: 480 },
        "360p": { width: 640, height: 360 },
      };

    const target = targetResolutions[value.toUpperCase()];
    if (!target) return false;

    const resolutionMatch = width === target.width && height === target.height;
    return operator === "equals" ? resolutionMatch : !resolutionMatch;
  }

  private matchCodec(
    filePath: string,
    operator: string,
    value: string,
  ): boolean {
    const lowerValue = value.toLowerCase();
    const hasCodec = filePath.toLowerCase().includes(lowerValue);
    return operator === "contains" ? hasCodec : !hasCodec;
  }

  private matchDuration(
    _filePath: string,
    _operator: string,
    _value: string,
  ): boolean {
    return false;
  }

  private matchFileSize(
    _filePath: string,
    _operator: string,
    _value: string,
  ): boolean {
    return false;
  }

  private async applyAction(
    videoId: number,
    action: TaggingRuleAction,
    filePath: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      switch (action.action_type) {
        case "add_tag":
          if (action.target_id) {
            await db
              .insert(videoTagsTable)
              .values({ videoId, tagId: action.target_id })
              .onConflictDoNothing();
          }
          break;

        case "remove_tag":
          if (action.target_id) {
            await db
              .delete(videoTagsTable)
              .where(
                and(
                  eq(videoTagsTable.videoId, videoId),
                  eq(videoTagsTable.tagId, action.target_id),
                ),
              );
          }
          break;

        case "add_creator":
          if (action.dynamic_value && action.dynamic_value.startsWith("$")) {
            const groupName = action.dynamic_value.slice(1);
            const creatorName = this.extractCreatorFromPath(
              filePath,
              groupName,
            );
            if (creatorName) {
              const existingCreator = await db
                .select()
                .from(creatorsTable)
                .where(eq(creatorsTable.name, creatorName));

              let creatorId: number;
              if (existingCreator.length === 0) {
                const result = await db
                  .insert(creatorsTable)
                  .values({ name: creatorName })
                  .returning({ id: creatorsTable.id });
                creatorId = result[0].id;
              } else {
                creatorId = existingCreator[0].id;
              }

              await db
                .insert(videoCreatorsTable)
                .values({ videoId, creatorId })
                .onConflictDoNothing();
            }
          } else if (action.target_id) {
            await db
              .insert(videoCreatorsTable)
              .values({ videoId, creatorId: action.target_id })
              .onConflictDoNothing();
          }
          break;

        case "remove_creator":
          if (action.target_id) {
            await db
              .delete(videoCreatorsTable)
              .where(
                and(
                  eq(videoCreatorsTable.videoId, videoId),
                  eq(videoCreatorsTable.creatorId, action.target_id),
                ),
              );
          }
          break;

        case "add_studio":
          if (action.dynamic_value && action.dynamic_value.startsWith("$")) {
            const groupName = action.dynamic_value.slice(1);
            const studioName = this.extractStudioFromPath(filePath, groupName);
            if (studioName) {
              const existingStudio = await db
                .select()
                .from(studiosTable)
                .where(eq(studiosTable.name, studioName));

              let studioId: number;
              if (existingStudio.length === 0) {
                const result = await db
                  .insert(studiosTable)
                  .values({ name: studioName })
                  .returning({ id: studiosTable.id });
                studioId = result[0].id;
              } else {
                studioId = existingStudio[0].id;
              }

              await db
                .insert(videoStudiosTable)
                .values({ videoId, studioId })
                .onConflictDoNothing();
            }
          } else if (action.target_id) {
            await db
              .insert(videoStudiosTable)
              .values({ videoId, studioId: action.target_id })
              .onConflictDoNothing();
          }
          break;

        case "remove_studio":
          if (action.target_id) {
            await db
              .delete(videoStudiosTable)
              .where(
                and(
                  eq(videoStudiosTable.videoId, videoId),
                  eq(videoStudiosTable.studioId, action.target_id),
                ),
              );
          }
          break;
      }

      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  private extractCreatorFromPath(
    filePath: string,
    groupName: string,
  ): string | null {
    const match = filePath.match(new RegExp(`\\(\\?<${groupName}>[^)]+\\)`));
    if (match) {
      const regex = new RegExp(
        match[0].replace(/\\?<\w+>/, "(?<creator>[^/]+)"),
      );
      const actualMatch = regex.exec(filePath);
      return actualMatch?.groups?.creator || null;
    }
    return null;
  }

  private extractStudioFromPath(
    filePath: string,
    groupName: string,
  ): string | null {
    return this.extractCreatorFromPath(filePath, groupName);
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
