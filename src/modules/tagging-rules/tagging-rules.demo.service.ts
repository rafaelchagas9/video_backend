import {
  getDemoSqlite,
  initializeDemoDatabase,
  withDemoTransaction,
} from "@/database/demo";
import { ConflictError, NotFoundError } from "@/utils/errors";
import type {
  ApplyRulesResult,
  CreateTaggingRuleInput,
  TaggingRule,
  TaggingRuleAction,
  TaggingRuleCondition,
  TestRuleResult,
  UpdateTaggingRuleInput,
} from "./tagging-rules.types";
import { studioAssignmentDemoService } from "@/modules/studios/studio-assignment.demo.service";

import { compileConditions, type RuleVideo } from "./tagging-rules.matcher";

const RESOURCE_KIND = "tagging-rule";

interface ResourceRow {
  id: string;
  payload_json: string;
}

function now(): string {
  return new Date().toISOString();
}

/** Persistent rule CRUD and application constrained to the demo SQLite file. */
export class TaggingRulesDemoService {
  async list(includeDisabled = false): Promise<TaggingRule[]> {
    initializeDemoDatabase();
    return getDemoSqlite()
      .query<ResourceRow, [string]>(
        `SELECT id, payload_json FROM demo_resources WHERE kind = ? ORDER BY id`
      )
      .all(RESOURCE_KIND)
      .map((row) => JSON.parse(row.payload_json) as TaggingRule)
      .filter((rule) => includeDisabled || rule.is_enabled)
      .sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name));
  }

  async findById(id: number): Promise<TaggingRule> {
    initializeDemoDatabase();
    const row = getDemoSqlite()
      .query<
        ResourceRow,
        [string, string]
      >("SELECT id, payload_json FROM demo_resources WHERE kind = ? AND id = ?")
      .get(RESOURCE_KIND, String(id));
    if (!row) throw new NotFoundError(`Tagging rule not found with id: ${id}`);
    return JSON.parse(row.payload_json) as TaggingRule;
  }

  async create(input: CreateTaggingRuleInput): Promise<TaggingRule> {
    const all = await this.list(true);
    if (all.some((rule) => rule.name === input.name)) {
      throw new ConflictError(
        `Tagging rule with name "${input.name}" already exists`
      );
    }
    const id = all.reduce((maximum, rule) => Math.max(maximum, rule.id), 0) + 1;
    const timestamp = now();
    const rule: TaggingRule = {
      id,
      name: input.name,
      description: input.description ?? null,
      rule_type: input.rule_type,
      is_enabled: input.is_enabled ?? true,
      priority: input.priority ?? 0,
      created_at: timestamp,
      updated_at: timestamp,
      conditions: this.conditions(id, input.conditions ?? []),
      actions: this.actions(id, input.actions ?? []),
    };
    this.persist(rule);
    return rule;
  }

  async update(
    id: number,
    input: UpdateTaggingRuleInput
  ): Promise<TaggingRule> {
    const existing = await this.findById(id);
    if (
      input.name &&
      (await this.list(true)).some(
        (rule) => rule.id !== id && rule.name === input.name
      )
    ) {
      throw new ConflictError(
        `Tagging rule with name "${input.name}" already exists`
      );
    }
    const updated: TaggingRule = {
      ...existing,
      name: input.name ?? existing.name,
      description:
        input.description !== undefined
          ? input.description
          : existing.description,
      rule_type: input.rule_type ?? existing.rule_type,
      is_enabled: input.is_enabled ?? existing.is_enabled,
      priority: input.priority ?? existing.priority,
      conditions:
        input.conditions !== undefined
          ? this.conditions(id, input.conditions)
          : existing.conditions,
      actions:
        input.actions !== undefined
          ? this.actions(id, input.actions)
          : existing.actions,
      updated_at: now(),
    };
    this.persist(updated);
    return updated;
  }

  async delete(id: number): Promise<void> {
    await this.findById(id);
    getDemoSqlite().run(
      "DELETE FROM demo_resources WHERE kind = ? AND id = ?",
      [RESOURCE_KIND, String(id)]
    );
  }

  async bulkDelete(ids: number[]): Promise<{ deleted: number }> {
    let deleted = 0;
    for (const id of ids) {
      deleted += getDemoSqlite().run(
        "DELETE FROM demo_resources WHERE kind = ? AND id = ?",
        [RESOURCE_KIND, String(id)]
      ).changes;
    }
    return { deleted };
  }

  async testRule(ruleId: number, limit = 10): Promise<TestRuleResult> {
    const rule = await this.findById(ruleId);
    const sampleMatches: TestRuleResult["sample_matches"] = [];
    const evaluate = compileConditions(rule.conditions ?? []);
    for (const video of this.videos(undefined, limit)) {
      const { matchedConditions: conditions } = evaluate(video);
      if (conditions.length > 0)
        sampleMatches.push({
          video_id: video.id,
          file_path: video.file_path,
          file_name: video.file_name,
          matched_conditions: conditions,
        });
    }
    return { matched: sampleMatches.length, sample_matches: sampleMatches };
  }

  async applyRules(input: {
    video_ids?: number[];
    dry_run?: boolean;
    limit?: number;
  }): Promise<ApplyRulesResult> {
    const rules = await this.list(false);
    const videos = rules.length
      ? this.videos(input.video_ids, input.limit ?? 100)
      : [];
    const evaluators = new Map(
      rules.map((rule) => [rule.id, compileConditions(rule.conditions ?? [])])
    );
    const result: ApplyRulesResult = {
      processed: videos.length,
      tagged: 0,
      errors: 0,
      details: { tags_added: 0, creators_added: 0, studios_added: 0 },
      log: [],
    };
    for (const video of videos) {
      let videoChanged = false;
      for (const rule of rules) {
        const { matchedConditions, captures } = evaluators.get(rule.id)!(video);
        if (matchedConditions.length === 0 || !rule.actions?.length) continue;
        if (input.dry_run) {
          videoChanged = true;
          result.log.push({
            video_id: video.id,
            rule_id: rule.id,
            success: true,
          });
          continue;
        }
        try {
          const changes = withDemoTransaction(() => {
            const counts = { changed: false, tags: 0, creators: 0, studios: 0 };
            for (const action of rule.actions ?? []) {
              if (!this.applyAction(video.id, action, captures)) continue;
              counts.changed = true;
              if (action.action_type === "add_tag") counts.tags++;
              if (action.action_type === "add_creator") counts.creators++;
              if (action.action_type === "add_studio") counts.studios++;
            }
            return counts;
          });
          videoChanged ||= changes.changed;
          result.details.tags_added += changes.tags;
          result.details.creators_added += changes.creators;
          result.details.studios_added += changes.studios;
          result.log.push({
            video_id: video.id,
            rule_id: rule.id,
            success: true,
          });
        } catch (error) {
          result.errors += 1;
          result.log.push({
            video_id: video.id,
            rule_id: rule.id,
            success: false,
            error: error instanceof Error ? error.message : "Unknown error",
          });
        }
      }
      if (videoChanged) result.tagged++;
    }
    return result;
  }

  private persist(rule: TaggingRule): void {
    getDemoSqlite().run(
      `INSERT INTO demo_resources (kind, id, payload_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT(kind, id) DO UPDATE SET
       payload_json = excluded.payload_json, updated_at = excluded.updated_at`,
      [
        RESOURCE_KIND,
        String(rule.id),
        JSON.stringify(rule),
        rule.created_at,
        rule.updated_at,
      ]
    );
  }

  private conditions(
    ruleId: number,
    items: NonNullable<
      | CreateTaggingRuleInput["conditions"]
      | UpdateTaggingRuleInput["conditions"]
    >
  ): TaggingRuleCondition[] {
    return items.map((condition, index) => ({
      id: index + 1,
      rule_id: ruleId,
      ...condition,
    }));
  }

  private actions(
    ruleId: number,
    items: NonNullable<
      CreateTaggingRuleInput["actions"] | UpdateTaggingRuleInput["actions"]
    >
  ): TaggingRuleAction[] {
    return items.map((action, index) => ({
      id: index + 1,
      rule_id: ruleId,
      action_type: action.action_type,
      target_id: action.target_id ?? null,
      target_name: action.target_name ?? null,
      dynamic_value: action.dynamic_value ?? null,
    }));
  }

  private videos(ids: number[] | undefined, limit: number): RuleVideo[] {
    initializeDemoDatabase();
    if (ids?.length === 0) return [];
    const uniqueIds = ids ? [...new Set(ids)] : undefined;
    return getDemoSqlite()
      .query<RuleVideo, number[]>(
        `SELECT id, file_path, file_name, duration_seconds, width, height, codec, file_size_bytes
       FROM demo_videos WHERE is_available = 1
       ${uniqueIds ? `AND id IN (${uniqueIds.map(() => "?").join(",")})` : ""}
       ORDER BY id LIMIT ?`
      )
      .all(...(uniqueIds ?? []), limit);
  }

  private applyAction(
    videoId: number,
    action: TaggingRuleAction,
    captures: Record<string, string>
  ): boolean {
    const kind = action.action_type.endsWith("tag")
      ? "tag"
      : action.action_type.endsWith("creator")
        ? "creator"
        : "studio";
    const addTarget = action.action_type.startsWith("add_");
    let targetId = action.target_id;
    const name = action.dynamic_value
      ? captures[action.dynamic_value.slice(1)]?.trim()
      : action.target_name?.trim();
    if (!targetId && name) {
      const table =
        kind === "tag"
          ? "demo_tags"
          : kind === "creator"
            ? "demo_creators"
            : "demo_studios";
      const where = `name = ?${kind === "tag" ? " AND parent_id IS NULL" : ""}`;
      let row = getDemoSqlite()
        .query<
          { id: number },
          [string]
        >(`SELECT id FROM ${table} WHERE ${where} ORDER BY id LIMIT 1`)
        .get(name);
      if (!row && addTarget) {
        getDemoSqlite().run(
          `INSERT INTO ${table} (name, created_at, updated_at) VALUES (?, ?, ?)`,
          [name, now(), now()]
        );
        row = getDemoSqlite()
          .query<
            { id: number },
            [string]
          >(`SELECT id FROM ${table} WHERE ${where} ORDER BY id LIMIT 1`)
          .get(name);
      }
      targetId = row?.id ?? null;
      if (!targetId && !addTarget) return false;
    }
    if (!targetId)
      throw new Error(`No target resolved for ${action.action_type}`);
    if (action.action_type === "add_studio") {
      return studioAssignmentDemoService.linkMany([videoId], [targetId]) > 0;
    }
    if (action.action_type === "remove_studio") {
      return studioAssignmentDemoService.unlinkMany([videoId], [targetId]) > 0;
    }
    const mapping = {
      add_tag: ["demo_video_tags", "tag_id", true],
      remove_tag: ["demo_video_tags", "tag_id", false],
      add_creator: ["demo_video_creators", "creator_id", true],
      remove_creator: ["demo_video_creators", "creator_id", false],
    } as const;
    const [table, column, add] = mapping[action.action_type];
    const operation = add
      ? getDemoSqlite().run(
          `INSERT OR IGNORE INTO ${table} (video_id, ${column}) VALUES (?, ?)`,
          [videoId, targetId]
        )
      : getDemoSqlite().run(
          `DELETE FROM ${table} WHERE video_id = ? AND ${column} = ?`,
          [videoId, targetId]
        );
    return operation.changes > 0;
  }
}

export const taggingRulesDemoService = new TaggingRulesDemoService();
