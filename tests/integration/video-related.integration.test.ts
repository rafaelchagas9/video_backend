import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { createTestApp, seedVideoFixture, type TestApp } from "../helpers/test-app";

describe("related recommendations against disposable PostgreSQL", () => {
  let ctx: TestApp;
  let service: import("@/modules/videos/videos.related.service").VideosRelatedService;
  beforeAll(async () => {
    ctx = await createTestApp();
    const { VideosRelatedService } = await import("@/modules/videos/videos.related.service");
    service = new VideosRelatedService();
  }, 60_000);
  afterAll(async () => { await ctx?.close(); });

  it("preserves scores and rating means across multiple relationship dimensions", async () => {
    const { db } = await import("@/config/drizzle");
    const { tagsTable, videoTagsTable, creatorsTable, videoCreatorsTable,
      studiosTable, videoStudiosTable, playlistsTable, playlistVideosTable,
      ratingsTable, favoritesTable } = await import("@/database/schema");
    const source = await seedVideoFixture("related-multi-source.mp4");
    const candidate = await seedVideoFixture("related-multi-candidate.mp4");
    const tags = await db.insert(tagsTable).values(
      [1, 2, 3].map((n) => ({ name: `related-multi-tag-${n}` })),
    ).returning();
    const creators = await db.insert(creatorsTable).values(
      [1, 2].map((n) => ({ name: `related-multi-creator-${n}` })),
    ).returning();
    const studios = await db.insert(studiosTable).values(
      [1, 2].map((n) => ({ name: `related-multi-studio-${n}` })),
    ).returning();
    const playlists = await db.insert(playlistsTable).values(
      [1, 2].map((n) => ({ name: `related-multi-playlist-${n}`, userId: ctx.userId })),
    ).returning();
    for (const videoId of [source.videoId, candidate.videoId]) {
      await db.insert(videoTagsTable).values(tags.map((tag) => ({ videoId, tagId: tag.id })));
      await db.insert(videoCreatorsTable).values(creators.map((creator) => ({ videoId, creatorId: creator.id })));
      await db.insert(videoStudiosTable).values(studios.map((studio) => ({ videoId, studioId: studio.id })));
      await db.insert(playlistVideosTable).values(playlists.map((playlist) => ({
        videoId, playlistId: playlist.id, position: videoId === source.videoId ? 0 : 1,
      })));
    }
    await db.insert(ratingsTable).values([
      { videoId: candidate.videoId, rating: 4 }, { videoId: candidate.videoId, rating: 5 },
    ]);
    await db.insert(favoritesTable).values({ videoId: candidate.videoId, userId: ctx.userId });
    const result = await service.getRelated(ctx.userId, source.videoId, { refresh: true });
    expect(result.data).toHaveLength(1);
    // 3 tags=54, 2 creators=48, 2 studios=28, 2 playlists=40,
    // duration=8, rating mean4.5=9, favorite=10, unwatched=6.
    expect(result.data[0]).toMatchObject({
      video: { id: candidate.videoId }, score: 203,
      reasons: ["shared-tags:3", "shared-creators:2", "shared-studios:2",
        "same-playlists:2", "similar-duration", "high-rating:4.5", "favorite", "unwatched"],
    });
    const cached = await service.getRelated(ctx.userId, source.videoId);
    expect(cached.meta.refreshed).toBe(false);
    expect(cached.data).toEqual(result.data);
  });

  it("caches empty results, bypasses on forced refresh, and clears on candidate invalidation", async () => {
    const { db } = await import("@/config/drizzle");
    const { tagsTable, videoTagsTable } = await import("@/database/schema");
    const source = await seedVideoFixture("related-empty-source.mp4");
    const candidate = await seedVideoFixture("related-empty-candidate.mp4");
    const refresh = spyOn(service, "refreshScores");
    try {
      const first = await service.getRelated(ctx.userId, source.videoId);
      expect(first).toMatchObject({ data: [], meta: { refreshed: true, candidate_count: 0 } });
      expect(first.meta.computed_at).not.toBeNull();
      const second = await service.getRelated(ctx.userId, source.videoId);
      expect(second).toMatchObject({ data: [], meta: { refreshed: false } });
      expect(second.meta.computed_at).toBe(first.meta.computed_at);
      expect(refresh).toHaveBeenCalledTimes(1);
      expect((await service.getRelated(ctx.userId, source.videoId, { refresh: true })).meta.refreshed).toBe(true);
      expect(refresh).toHaveBeenCalledTimes(2);
      const [tag] = await db.insert(tagsTable).values({ name: "related-empty-new-match" }).returning();
      await db.insert(videoTagsTable).values([
        { videoId: source.videoId, tagId: tag!.id },
        { videoId: candidate.videoId, tagId: tag!.id },
      ]);
      // Invalidating a changed candidate must clear other sources' negative cache.
      await service.invalidateForVideos([candidate.videoId]);
      const after = await service.getRelated(ctx.userId, source.videoId);
      expect(refresh).toHaveBeenCalledTimes(3);
      expect(after.data.map((row) => row.video.id)).toEqual([candidate.videoId]);
    } finally { refresh.mockRestore(); }
  });

  it("rolls back score deletion when replacement inserts fail", async () => {
    const { db } = await import("@/config/drizzle");
    const { tagsTable, videoTagsTable, videoRelatedScoresTable } = await import("@/database/schema");
    const source = await seedVideoFixture("related-rollback-source.mp4");
    const candidate = await seedVideoFixture("related-rollback-candidate.mp4");
    const [tag] = await db.insert(tagsTable).values({ name: "related-rollback-tag" }).returning();
    await db.insert(videoTagsTable).values([
      { videoId: source.videoId, tagId: tag!.id }, { videoId: candidate.videoId, tagId: tag!.id },
    ]);
    await db.insert(videoRelatedScoresTable).values({
      sourceVideoId: source.videoId, relatedVideoId: candidate.videoId,
      score: 17, reasonsJson: '["existing-score"]',
    });
    const previous = await db.select().from(videoRelatedScoresTable)
      .where(eq(videoRelatedScoresTable.sourceVideoId, source.videoId));
    // Failure injection lives exclusively in this suite's throwaway database.
    await db.execute(sql`CREATE FUNCTION related_test_reject_insert() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test replacement insert rejected'; END; $$`);
    try {
      await db.execute(sql`CREATE TRIGGER related_test_reject_insert
        BEFORE INSERT ON video_related_scores FOR EACH ROW
        EXECUTE FUNCTION related_test_reject_insert()`);
      await expect(service.refreshScores(ctx.userId, source.videoId)).rejects.toThrow();
      const after = await db.select().from(videoRelatedScoresTable)
        .where(eq(videoRelatedScoresTable.sourceVideoId, source.videoId));
      expect(after).toEqual(previous);
    } finally {
      await db.execute(sql`DROP TRIGGER IF EXISTS related_test_reject_insert ON video_related_scores`);
      await db.execute(sql`DROP FUNCTION related_test_reject_insert()`);
    }
    // The failed refresh must release its advisory lock and leave the service usable.
    await service.refreshScores(ctx.userId, source.videoId);
    const recovered = await db.select().from(videoRelatedScoresTable)
      .where(eq(videoRelatedScoresTable.sourceVideoId, source.videoId));
    expect(recovered).toHaveLength(1);
    expect(Number(recovered[0]!.score)).toBe(32);
  });
});
