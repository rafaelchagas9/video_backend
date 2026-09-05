import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getDemoSqlite,
  initializeDemoDatabase,
  setDemoDatabasePathForTests,
} from "@/database/demo";
import { TaggingRulesDemoService } from "@/modules/tagging-rules/tagging-rules.demo.service";
import type { CreateTaggingRuleInput } from "@/modules/tagging-rules/tagging-rules.types";

const service = new TaggingRulesDemoService();
const root = mkdtempSync(join(tmpdir(), "tagging-rule-regression-"));
const input: CreateTaggingRuleInput = {
  name: "Metadata rule",
  rule_type: "metadata_match",
  is_enabled: true,
  priority: 1,
  conditions: [
    { condition_type: "duration_range", operator: "gte", value: "60" },
  ],
  actions: [
    { action_type: "add_tag", target_id: 1 },
    { action_type: "add_creator", target_id: 1 },
  ],
};
beforeAll(() => {
  setDemoDatabasePathForTests(join(root, "test.sqlite"));
  initializeDemoDatabase();
});
afterAll(() => {
  setDemoDatabasePathForTests(null);
  rmSync(root, { recursive: true, force: true });
});
beforeEach(() => {
  const db = getDemoSqlite();
  db.exec(
    "DELETE FROM demo_video_tags; DELETE FROM demo_video_creators; DELETE FROM demo_video_studios; DELETE FROM demo_videos; DELETE FROM demo_resources; DELETE FROM demo_tags; DELETE FROM demo_creators; DELETE FROM demo_studios;"
  );
  for (const table of ["demo_tags", "demo_creators", "demo_studios"])
    db.run(
      `INSERT INTO ${table} (id, name, created_at, updated_at) VALUES (1, 'Existing', '2026-01-01', '2026-01-01')`
    );
  for (const id of [1, 2])
    db.run(
      `INSERT INTO demo_videos (id, directory_id, file_path, file_name, duration_seconds, file_size_bytes, width, height, codec, is_available, indexed_at, created_at, updated_at) VALUES (?, 1, '/library/Ada/clip.mp4', 'clip.mp4', 120, 2048, 1920, 1080, 'h264', 1, '2026-01-01', '2026-01-01', '2026-01-01')`,
      [id]
    );
});

describe("tagging rules on disposable SQLite", () => {
  it("uses indexed metadata in preview, dry run and application; counts videos and actual additions", async () => {
    const rule = await service.create(input);
    expect((await service.testRule(rule.id, 1)).matched).toBe(1);
    expect((await service.applyRules({ dry_run: true, limit: 1 })).tagged).toBe(
      1
    );
    expect(
      getDemoSqlite().query("SELECT * FROM demo_video_tags").all()
    ).toHaveLength(0);
    expect(await service.applyRules({ limit: 1 })).toMatchObject({
      processed: 1,
      tagged: 1,
      errors: 0,
      details: { tags_added: 1, creators_added: 1, studios_added: 0 },
    });
    expect(await service.applyRules({ limit: 1 })).toMatchObject({
      tagged: 0,
      details: { tags_added: 0, creators_added: 0, studios_added: 0 },
    });
  });
  it("does no work for an explicitly empty selection and honors selected IDs and limit", async () => {
    await service.create(input);
    expect((await service.applyRules({ video_ids: [] })).processed).toBe(0);
    expect(
      (await service.applyRules({ video_ids: [2, 1, 2], limit: 1 })).processed
    ).toBe(1);
    expect(
      getDemoSqlite().query("SELECT video_id FROM demo_video_tags").all()
    ).toEqual([{ video_id: 1 }]);
  });
  it("rolls back every action when a later target is invalid and reports the failure", async () => {
    await service.create({
      ...input,
      actions: [
        { action_type: "add_tag", target_id: 1 },
        { action_type: "add_creator", target_id: 99999 },
      ],
    });
    const result = await service.applyRules({ limit: 1 });
    expect(result).toMatchObject({
      tagged: 0,
      errors: 1,
      details: { tags_added: 0, creators_added: 0, studios_added: 0 },
    });
    expect(result.log[0]?.success).toBe(false);
    expect(
      getDemoSqlite().query("SELECT * FROM demo_video_tags").all()
    ).toHaveLength(0);
  });
  it("extracts dynamic names from the matching condition and reuses named targets", async () => {
    await service.create({
      ...input,
      conditions: [
        {
          condition_type: "path_pattern",
          operator: "regex",
          value: "/library/(?<creator>[^/]+)/",
        },
      ],
      actions: [
        { action_type: "add_creator", dynamic_value: "$creator" },
        { action_type: "add_tag", target_name: "Auto" },
        { action_type: "add_studio", target_name: "Studio" },
      ],
    });
    expect(await service.applyRules({ limit: 2 })).toMatchObject({
      tagged: 2,
      errors: 0,
      details: { tags_added: 2, creators_added: 2, studios_added: 2 },
    });
    expect(
      getDemoSqlite()
        .query("SELECT name FROM demo_creators WHERE name = 'Ada'")
        .all()
    ).toHaveLength(1);
    expect(
      getDemoSqlite()
        .query("SELECT name FROM demo_tags WHERE name = 'Auto'")
        .all()
    ).toHaveLength(1);
    expect((await service.applyRules({ limit: 2 })).tagged).toBe(0);
  });
  it("reports unresolved capture targets as errors instead of successful no-ops", async () => {
    await service.create({
      ...input,
      actions: [{ action_type: "add_creator", dynamic_value: "$missing" }],
    });
    expect(await service.applyRules({ limit: 1 })).toMatchObject({
      tagged: 0,
      errors: 1,
    });
  });
  it("preserves OR matching, but empty conditions/actions do not apply", async () => {
    const rule = await service.create({
      ...input,
      conditions: [
        { condition_type: "codec", operator: "equals", value: "av1" },
        ...input.conditions!,
      ],
    });
    expect((await service.testRule(rule.id)).matched).toBe(2);
    await service.update(rule.id, { actions: [] });
    expect((await service.applyRules({ dry_run: true })).tagged).toBe(0);
    await service.update(rule.id, { conditions: [], actions: input.actions });
    expect((await service.testRule(rule.id)).matched).toBe(0);
  });
  it("skips unavailable selected videos", async () => {
    await service.create(input);
    getDemoSqlite().run("UPDATE demo_videos SET is_available = 0 WHERE id = 1");
    expect((await service.applyRules({ video_ids: [1] })).processed).toBe(0);
  });
});
