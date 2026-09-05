import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import {
  createTestApp,
  seedVideoFixture,
  type TestApp,
} from "../helpers/test-app";

describe("video relationship mutations", () => {
  let ctx: TestApp;
  beforeAll(async () => {
    ctx = await createTestApp();
  }, 60_000);
  afterAll(async () => {
    await ctx?.close();
  });

  it("reports zero committed work after a later action rolls back the batch", async () => {
    const { db } = await import("@/config/drizzle");
    const { creatorsTable, videoCreatorsTable } =
      await import("@/database/schema");
    const { triageService } = await import("@/modules/triage/triage.service");
    const { videoId } = await seedVideoFixture("rollback-relations.mp4");
    const [creator] = await db
      .insert(creatorsTable)
      .values({ name: "Rollback creator" })
      .returning();
    const result = await triageService.applyBulkActions({
      videoIds: [videoId],
      actions: { addCreatorIds: [creator!.id], addTagIds: [999999] },
    });
    expect(
      await db
        .select()
        .from(videoCreatorsTable)
        .where(eq(videoCreatorsTable.videoId, videoId))
    ).toHaveLength(0);
    expect(result).toMatchObject({
      success: false,
      processed: 0,
      errors: 1,
      details: { creators_added: 0, tags_added: 0 },
    });
  });

  it("counts unique video IDs and only affected rows in conditional apply", async () => {
    const { db } = await import("@/config/drizzle");
    const { tagsTable } = await import("@/database/schema");
    const { triageService } = await import("@/modules/triage/triage.service");
    const { videosBulkService } =
      await import("@/modules/videos/videos.bulk.service");
    const { videoId, directoryId } = await seedVideoFixture(
      "unique-relations.mp4"
    );
    const [tag] = await db
      .insert(tagsTable)
      .values({ name: "Unique relation" })
      .returning();
    expect(
      await triageService.applyBulkActions({
        videoIds: [videoId, videoId],
        actions: { addTagIds: [tag!.id, tag!.id] },
      })
    ).toMatchObject({ processed: 1, errors: 0, details: { tags_added: 1 } });
    expect(
      await videosBulkService.bulkConditionalApply(
        ctx.userId,
        { directory_id: directoryId },
        { addTagIds: [tag!.id] }
      )
    ).toMatchObject({
      matched: 1,
      affected: 0,
      errors: 0,
      details: { tags_added: 0 },
    });
  });

  it("does not report missing videos as successfully processed for removal", async () => {
    const { triageService } = await import("@/modules/triage/triage.service");
    expect(
      await triageService.applyBulkActions({
        videoIds: [999999],
        actions: { removeTagIds: [1] },
      })
    ).toMatchObject({ processed: 0, errors: 1 });
  });

  it("excludes unavailable creator links from the available-video statistics", async () => {
    const { db } = await import("@/config/drizzle");
    const { creatorsTable, videosTable, videoCreatorsTable } =
      await import("@/database/schema");
    const { triageService } = await import("@/modules/triage/triage.service");
    const before = await triageService.getStatistics(ctx.userId);
    const { videoId } = await seedVideoFixture("unavailable-relations.mp4");
    const [creator] = await db
      .insert(creatorsTable)
      .values({ name: "Unavailable creator" })
      .returning();
    await db
      .update(videosTable)
      .set({ isAvailable: false })
      .where(eq(videosTable.id, videoId));
    await db
      .insert(videoCreatorsTable)
      .values({ videoId, creatorId: creator!.id });
    const after = await triageService.getStatistics(ctx.userId);
    expect(after.total_untagged_videos).toBe(before.total_untagged_videos);
    expect(after.tagged_percentage).toBe(before.tagged_percentage);
  });
  it("invalidates related scores for creator/tag changes through both entry points", async () => {
    const { db } = await import("@/config/drizzle");
    const { creatorsTable, tagsTable, videoRelatedScoresTable } =
      await import("@/database/schema");
    const { triageService } = await import("@/modules/triage/triage.service");
    const { videosBulkService } =
      await import("@/modules/videos/videos.bulk.service");
    const one = await seedVideoFixture("cache-relations-one.mp4");
    const two = await seedVideoFixture("cache-relations-two.mp4");
    const [creator] = await db
      .insert(creatorsTable)
      .values({ name: "Cache creator" })
      .returning();
    const [tag] = await db
      .insert(tagsTable)
      .values({ name: "Cache tag" })
      .returning();
    const seedCache = () =>
      db.insert(videoRelatedScoresTable).values([
        {
          sourceVideoId: one.videoId,
          relatedVideoId: two.videoId,
          score: 1,
          reasonsJson: "[]",
        },
        {
          sourceVideoId: two.videoId,
          relatedVideoId: one.videoId,
          score: 1,
          reasonsJson: "[]",
        },
      ]);
    await seedCache();
    await triageService.applyBulkActions({
      videoIds: [one.videoId],
      actions: { addCreatorIds: [creator!.id] },
    });
    expect(await db.select().from(videoRelatedScoresTable)).toHaveLength(0);
    await seedCache();
    await videosBulkService.bulkUpdateTags({
      videoIds: [one.videoId],
      tagIds: [tag!.id],
      action: "add",
    });
    expect(await db.select().from(videoRelatedScoresTable)).toHaveLength(0);
  });

  it("keeps other users' saved filter keys out of triage statistics", async () => {
    const { db } = await import("@/config/drizzle");
    const { usersTable } = await import("@/database/schema");
    const { triageService } = await import("@/modules/triage/triage.service");
    const [other] = await db
      .insert(usersTable)
      .values({ name: "Other", email: "other-stats@example.test" })
      .returning();
    const fixture = await seedVideoFixture("private-stats.mp4");
    await triageService.saveProgress(other!.id, {
      filterKey: "private-filter",
      lastVideoId: fixture.videoId,
      processedCount: 1,
    });
    await triageService.saveProgress(ctx.userId, {
      filterKey: "own-filter",
      lastVideoId: fixture.videoId,
      processedCount: 1,
    });
    const response = await ctx.authInject({
      method: "GET",
      url: "/api/triage/stats",
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(
      response
        .json()
        .data.filter_breakdown.map(
          (row: { filter_key: string }) => row.filter_key
        )
    ).toEqual(["own-filter"]);
  });
});
