import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { seedVideoFixture } from "../helpers/test-app";
import {
  startTestDatabase,
  applyTestDatabaseEnv,
  migrateTestDatabase,
} from "../helpers/test-database";

describe("video list and navigation filters", () => {
  let ctx: { userId: number; close(): Promise<void> };
  let videoIds: number[];
  let creatorIds: number[];
  let tagIds: number[];
  beforeAll(async () => {
    const database = await startTestDatabase();
    applyTestDatabaseEnv(database);
    await migrateTestDatabase();
    const { closeDrizzleDatabase } = await import("@/config/drizzle");
    ctx = {
      userId: 1,
      close: async () => {
        await closeDrizzleDatabase();
        await database.stop();
      },
    };
    const { db } = await import("@/config/drizzle");
    const {
      creatorsTable,
      tagsTable,
      videoCreatorsTable,
      videoTagsTable,
      ratingsTable,
      videosTable,
    } = await import("@/database/schema");
    videoIds = [];
    for (let index = 0; index < 3; index++)
      videoIds.push((await seedVideoFixture(`search-${index}.mp4`)).videoId);
    creatorIds = (
      await db
        .insert(creatorsTable)
        .values([{ name: "Search A" }, { name: "Search B" }])
        .returning()
    ).map((row) => row.id);
    tagIds = (
      await db
        .insert(tagsTable)
        .values([{ name: "Search tag A" }, { name: "Search tag B" }])
        .returning()
    ).map((row) => row.id);
    await db.insert(videoCreatorsTable).values([
      { videoId: videoIds[0]!, creatorId: creatorIds[0]! },
      { videoId: videoIds[0]!, creatorId: creatorIds[1]! },
      { videoId: videoIds[1]!, creatorId: creatorIds[0]! },
    ]);
    await db.insert(videoTagsTable).values([
      { videoId: videoIds[0]!, tagId: tagIds[0]! },
      { videoId: videoIds[0]!, tagId: tagIds[1]! },
      { videoId: videoIds[1]!, tagId: tagIds[0]! },
    ]);
    await db.insert(ratingsTable).values([
      { videoId: videoIds[0]!, rating: 5 },
      { videoId: videoIds[0]!, rating: 3 },
      { videoId: videoIds[1]!, rating: 2 },
    ]);
    // Every fixture has duration 120, deliberately exercising the ID tie-break.
    await db
      .update(videosTable)
      .set({ durationSeconds: 120 })
      .where(eq(videosTable.id, videoIds[0]!));
  }, 60_000);
  afterAll(async () => {
    await ctx?.close();
  });

  it("returns each any-match video exactly once with accurate page totals", async () => {
    const { videosSearchService: service } =
      await import("@/modules/videos/videos.search.service");
    const result = await service.list(ctx.userId, {
      creatorIds,
      tagIds,
      matchMode: "any",
      limit: 1,
      page: 2,
      sort: "duration_seconds",
      order: "asc",
    });
    expect(result.pagination).toMatchObject({ total: 2, totalPages: 2 });
    expect(result.data.map((video) => video.id)).toEqual([videoIds[1]!]);
  });
  it("applies average-rating filters to both results and counts, including all-match filters", async () => {
    const { videosSearchService: service } =
      await import("@/modules/videos/videos.search.service");
    for (const filters of [
      { minRating: 3, maxRating: 4 },
      {
        minRating: 3,
        maxRating: 4,
        creatorIds,
        tagIds,
        matchMode: "all" as const,
      },
    ]) {
      const result = await service.list(ctx.userId, filters);
      expect(result.pagination.total).toBe(1);
      expect(result.data.map((video) => video.id)).toEqual([videoIds[0]!]);
    }
  });
  it("applies selected creator/tag IDs and ratings to triage queues and conditional bulk selections", async () => {
    const { videosSearchService: service } =
      await import("@/modules/videos/videos.search.service");
    const { videosBulkService } =
      await import("@/modules/videos/videos.bulk.service");
    const filter = {
      creatorIds,
      tagIds,
      matchMode: "all" as const,
      minRating: 3,
    };
    expect(await service.getTriageQueue(ctx.userId, filter)).toMatchObject({
      ids: [videoIds[0]!],
      total: 1,
    });
    expect(
      await videosBulkService.bulkConditionalApply(ctx.userId, filter, {})
    ).toMatchObject({ matched: 1, affected: 0 });
  });
  it("deduplicates repeated all-mode IDs rather than requiring impossible counts", async () => {
    const { videosSearchService: service } =
      await import("@/modules/videos/videos.search.service");
    const result = await service.list(ctx.userId, {
      creatorIds: [creatorIds[0]!, creatorIds[0]!],
      matchMode: "all",
    });
    expect(result.pagination.total).toBe(2);
  });
  it("moves through tied sort values in both directions and wraps only at the end", async () => {
    const { videosSearchService: service } =
      await import("@/modules/videos/videos.search.service");
    const options = {
      sort: "duration_seconds",
      order: "asc" as const,
      direction: "next" as const,
    };
    const next = await service.getNextVideo(ctx.userId, {
      ...options,
      currentId: videoIds[1]!,
    });
    expect(next.video?.id).toBe(videoIds[2]!);
    expect(next.meta.has_wrapped).toBe(false);
    const wrap = await service.getNextVideo(ctx.userId, {
      ...options,
      currentId: videoIds[2]!,
    });
    expect(wrap.video?.id).toBe(videoIds[0]!);
    expect(wrap.meta.has_wrapped).toBe(true);
    const previous = await service.getNextVideo(ctx.userId, {
      ...options,
      currentId: videoIds[1]!,
      direction: "previous",
    });
    expect(previous.video?.id).toBe(videoIds[0]!);
  });
  it("navigates nullable sort groups and never returns negative remaining counts", async () => {
    const { db } = await import("@/config/drizzle");
    const { videosTable } = await import("@/database/schema");
    const { videosSearchService: service } =
      await import("@/modules/videos/videos.search.service");
    for (const id of [videoIds[1]!, videoIds[2]!])
      await db
        .update(videosTable)
        .set({ durationSeconds: null })
        .where(eq(videosTable.id, id));
    const options = {
      sort: "duration_seconds",
      order: "asc" as const,
      direction: "next" as const,
    };
    const afterKnown = await service.getNextVideo(ctx.userId, {
      ...options,
      currentId: videoIds[0]!,
    });
    expect(afterKnown.video?.id).toBe(videoIds[1]!);
    expect(afterKnown.meta.has_wrapped).toBe(false);
    const afterNull = await service.getNextVideo(ctx.userId, {
      ...options,
      currentId: videoIds[1]!,
    });
    expect(afterNull.video?.id).toBe(videoIds[2]!);
    expect(afterNull.meta.has_wrapped).toBe(false);
    const descending = await service.getNextVideo(ctx.userId, {
      ...options,
      order: "desc",
      currentId: videoIds[2]!,
    });
    expect(descending.video?.id).toBe(videoIds[1]!);
    const none = await service.getNextVideo(ctx.userId, {
      ...options,
      currentId: videoIds[0]!,
      creatorIds: [999999],
    });
    expect(none.video).toBe(null);
    expect(none.meta.remaining).toBe(0);
  });
  it("uses the same selected parent-tag subtree semantics for every search consumer", async () => {
    const { db } = await import("@/config/drizzle");
    const { tagsTable, videoTagsTable } = await import("@/database/schema");
    const { videosSearchService: service } =
      await import("@/modules/videos/videos.search.service");
    const [parent] = await db
      .insert(tagsTable)
      .values({ name: "Parent filter" })
      .returning();
    const [child] = await db
      .insert(tagsTable)
      .values({ name: "Child filter", parentId: parent!.id })
      .returning();
    await db
      .insert(videoTagsTable)
      .values({ videoId: videoIds[1]!, tagId: child!.id });
    await db.insert(tagsTable).values({ name: "Unmatched sibling", parentId: parent!.id });
    const filter = {
      tagIds: [parent!.id, child!.id],
      matchMode: "all" as const,
    };
    expect(
      (await service.list(ctx.userId, filter)).data.map((video) => video.id)
    ).toEqual([videoIds[1]!]);
    expect((await service.getTriageQueue(ctx.userId, filter)).ids).toEqual([
      videoIds[1]!,
    ]);
    const { videosService } = await import("@/modules/videos/videos.service");
    const random = await videosService.getRandomVideo(ctx.userId, { ...filter, limit: 10 });
    expect(Array.isArray(random) ? random.map((video) => video.id) : []).toEqual([videoIds[1]!]);
  });
});
