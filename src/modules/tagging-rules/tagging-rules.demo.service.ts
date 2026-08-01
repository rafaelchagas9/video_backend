import { getDemoSqlite, initializeDemoDatabase } from "@/database/demo";
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

const RESOURCE_KIND = "tagging-rule";

interface ResourceRow {
  id: string;
  payload_json: string;
}
interface DemoVideo {
  id: number;
  file_path: string;
  file_name: string;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  codec: string | null;
  file_size_bytes: number;
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
    for (const video of this.videos(undefined, limit)) {
      const conditions = this.evaluate(video, rule.conditions ?? []);
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
    const videos = this.videos(input.video_ids, input.limit ?? 100);
    const result: ApplyRulesResult = {
      processed: videos.length,
      tagged: 0,
      errors: 0,
      details: { tags_added: 0, creators_added: 0, studios_added: 0 },
      log: [],
    };
    for (const video of videos) {
      for (const rule of rules) {
        if (this.evaluate(video, rule.conditions ?? []).length === 0) continue;
        if (input.dry_run) {
          result.tagged += 1;
          result.log.push({
            video_id: video.id,
            rule_id: rule.id,
            success: true,
          });
          continue;
        }
        try {
          for (const action of rule.actions ?? []) {
            if (!this.applyAction(video.id, action)) continue;
            result.tagged += 1;
            if (action.action_type === "add_tag")
              result.details.tags_added += 1;
            if (action.action_type === "add_creator")
              result.details.creators_added += 1;
            if (action.action_type === "add_studio")
              result.details.studios_added += 1;
          }
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

  private videos(ids: number[] | undefined, limit: number): DemoVideo[] {
    initializeDemoDatabase();
    const all = getDemoSqlite()
      .query<DemoVideo, []>(
        `SELECT id, file_path, file_name, duration_seconds, width, height, codec, file_size_bytes
       FROM demo_videos WHERE is_available = 1 ORDER BY id`
      )
      .all();
    return (
      ids?.length ? all.filter((video) => ids.includes(video.id)) : all
    ).slice(0, limit);
  }

  private evaluate(
    video: DemoVideo,
    conditions: TaggingRuleCondition[]
  ): string[] {
    return conditions
      .filter((condition) => this.matches(video, condition))
      .map(
        (condition) =>
          `${condition.condition_type} ${condition.operator} ${condition.value}`
      );
  }

  private matches(video: DemoVideo, condition: TaggingRuleCondition): boolean {
    const actual =
      condition.condition_type === "path_pattern"
        ? video.file_path
        : condition.condition_type === "file_pattern"
          ? video.file_name
          : condition.condition_type === "duration_range"
            ? video.duration_seconds
            : condition.condition_type === "resolution"
              ? video.height
              : condition.condition_type === "codec"
                ? video.codec
                : video.file_size_bytes;
    if (actual === null) return false;
    if (typeof actual === "number") {
      const numeric = Number(
        condition.condition_type === "resolution"
          ? condition.value.replace(/p$/i, "")
          : condition.value
      );
      if (!Number.isFinite(numeric)) return false;
      if (condition.operator === "gt") return actual > numeric;
      if (condition.operator === "gte") return actual >= numeric;
      if (condition.operator === "lt") return actual < numeric;
      if (condition.operator === "lte") return actual <= numeric;
      return actual === numeric;
    }
    if (condition.operator === "contains")
      return actual.toLowerCase().includes(condition.value.toLowerCase());
    if (condition.operator === "equals")
      return actual.toLowerCase() === condition.value.toLowerCase();
    if (condition.operator === "matches" || condition.operator === "regex") {
      try {
        return new RegExp(condition.value, "i").test(actual);
      } catch {
        return false;
      }
    }
    return false;
  }

  private applyAction(videoId: number, action: TaggingRuleAction): boolean {
    if (!action.target_id) return false;
    const mapping = {
      add_tag: ["demo_video_tags", "tag_id", true],
      remove_tag: ["demo_video_tags", "tag_id", false],
      add_creator: ["demo_video_creators", "creator_id", true],
      remove_creator: ["demo_video_creators", "creator_id", false],
      add_studio: ["demo_video_studios", "studio_id", true],
      remove_studio: ["demo_video_studios", "studio_id", false],
    } as const;
    const [table, column, add] = mapping[action.action_type];
    const operation = add
      ? getDemoSqlite().run(
          `INSERT OR IGNORE INTO ${table} (video_id, ${column}) VALUES (?, ?)`,
          [videoId, action.target_id]
        )
      : getDemoSqlite().run(
          `DELETE FROM ${table} WHERE video_id = ? AND ${column} = ?`,
          [videoId, action.target_id]
        );
    return operation.changes > 0;
  }
}

export const taggingRulesDemoService = new TaggingRulesDemoService();
