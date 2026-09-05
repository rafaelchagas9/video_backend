import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import {
  createTestApp,
  seedVideoFixture,
  type TestApp,
} from "../helpers/test-app";

describe("tagging rules on disposable PostgreSQL", () => {
  let ctx: TestApp;
  beforeAll(async () => {
    ctx = await createTestApp();
  }, 60_000);
  afterAll(async () => {
    await ctx?.close();
  });

  it("matches metadata, applies atomically, counts changes accurately and clears children", async () => {
    const { db } = await import("@/config/drizzle");
    const { taggingRulesService: service } =
      await import("@/modules/tagging-rules/tagging-rules.service");
    const { tagsTable, videosTable, videoTagsTable, creatorsTable } =
      await import("@/database/schema");
    const fixture = await seedVideoFixture("tagging-metadata.mp4");
    await db
      .update(videosTable)
      .set({ height: 1080, width: 1920, codec: "h264" })
      .where(eq(videosTable.id, fixture.videoId));
    const [tag] = await db
      .insert(tagsTable)
      .values({ name: "Metadata match" })
      .returning();
    const rule = await service.create({
      name: "Metadata",
      rule_type: "metadata_match",
      is_enabled: true,
      priority: 0,
      conditions: [
        { condition_type: "duration_range", operator: "gte", value: "120" },
      ],
      actions: [
        { action_type: "add_tag", target_id: tag!.id },
        { action_type: "add_creator", target_name: "Ada" },
      ],
    });
    expect((await service.testRule(rule.id)).matched).toBe(1);
    expect(
      (await service.applyRules({ video_ids: [], dry_run: false })).processed
    ).toBe(0);
    expect((await service.applyRules({ dry_run: true })).tagged).toBe(1);
    expect(await db.select().from(videoTagsTable)).toHaveLength(0);
    expect(
      await service.applyRules({ video_ids: [fixture.videoId] })
    ).toMatchObject({
      processed: 1,
      tagged: 1,
      errors: 0,
      details: { tags_added: 1, creators_added: 1, studios_added: 0 },
    });
    expect(
      await service.applyRules({ video_ids: [fixture.videoId] })
    ).toMatchObject({
      tagged: 0,
      details: { tags_added: 0, creators_added: 0, studios_added: 0 },
    });
    expect(
      await db.select().from(creatorsTable).where(eq(creatorsTable.name, "Ada"))
    ).toHaveLength(1);

    await service.update(rule.id, {
      actions: [
        { action_type: "remove_tag", target_id: tag!.id },
        { action_type: "add_creator", target_id: 999999 },
      ],
    });
    expect(
      await service.applyRules({ video_ids: [fixture.videoId] })
    ).toMatchObject({ tagged: 0, errors: 1 });
    expect(await db.select().from(videoTagsTable)).toHaveLength(1);

    const clear = await ctx.authInject({
      method: "PATCH",
      url: `/api/tagging-rules/${rule.id}`,
      payload: { conditions: [], actions: [] },
    });
    expect(clear.statusCode, clear.body).toBe(200);
    expect(await service.findById(rule.id)).toMatchObject({
      conditions: [],
      actions: [],
    });
    expect(await service.bulkDelete([rule.id, rule.id, 999999])).toEqual({
      deleted: 1,
    });
  });

  it("extracts captures from the matched regex, bounds explicit selections and validates input", async () => {
    const { db } = await import("@/config/drizzle");
    const { taggingRulesService: service } =
      await import("@/modules/tagging-rules/tagging-rules.service");
    const { creatorsTable, tagsTable, videoTagsTable } =
      await import("@/database/schema");
    const fixture = await seedVideoFixture("capture-Bob.mp4");
    const second = await seedVideoFixture("capture-Bob-second.mp4");
    const rule = await service.create({
      name: "Capture",
      rule_type: "path_match",
      is_enabled: true,
      priority: 1,
      conditions: [
        {
          condition_type: "file_pattern",
          operator: "regex",
          value: "capture-(?<creator>[^.-]+)",
        },
      ],
      actions: [
        { action_type: "add_creator", dynamic_value: "$creator" },
        { action_type: "add_tag", target_name: "Root auto" },
        { action_type: "add_studio", target_name: "Capture studio" },
      ],
    });
    expect(
      await service.applyRules({
        video_ids: [fixture.videoId, second.videoId],
        limit: 1,
      })
    ).toMatchObject({
      processed: 1,
      tagged: 1,
      errors: 0,
      details: { tags_added: 1, creators_added: 1, studios_added: 1 },
    });
    expect(
      await db.select().from(creatorsTable).where(eq(creatorsTable.name, "Bob"))
    ).toHaveLength(1);
    expect(
      await db.select().from(tagsTable).where(eq(tagsTable.name, "Root auto"))
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(videoTagsTable)
        .where(eq(videoTagsTable.videoId, second.videoId))
    ).toHaveLength(0);
    const invalid = await ctx.authInject({
      method: "PATCH",
      url: `/api/tagging-rules/${rule.id}`,
      payload: {
        conditions: [
          {
            condition_type: "duration_range",
            operator: "contains",
            value: "1",
          },
        ],
      },
    });
    expect(invalid.statusCode).toBe(400);
    await service.update(rule.id, { is_enabled: false });
    const listed = await ctx.authInject({
      method: "GET",
      url: "/api/tagging-rules?include_disabled=false",
    });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json().data).toEqual([]);
  });
});
