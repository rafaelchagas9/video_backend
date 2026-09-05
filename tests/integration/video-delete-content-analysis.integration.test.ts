import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { TestApp } from "../helpers/test-app";
import { createTestApp, seedVideoFixture } from "../helpers/test-app";

describe("video deletion with content analysis", () => {
  let ctx: TestApp | undefined;

  beforeAll(async () => {
    ctx = await createTestApp();
  }, 60_000);

  afterAll(async () => {
    await ctx?.close();
  });

  it("deletes a video with published automatic bookmarks", async () => {
    const fixture = await seedVideoFixture("analyzed-video-delete.mp4");
    const { db } = await import("@/config/drizzle");
    const {
      bookmarksTable,
      contentAnalysisRunsTable,
      durableJobsTable,
    } = await import("@/database/schema");

    const now = new Date();
    const [job] = await db
      .insert(durableJobsTable)
      .values({
        kind: "content_analysis",
        payload: { videoId: fixture.videoId },
        status: "completed",
        completedAt: now,
      })
      .returning({ id: durableJobsTable.id });
    const [run] = await db
      .insert(contentAnalysisRunsTable)
      .values({
        durableJobId: job!.id,
        videoId: fixture.videoId,
        userId: ctx!.userId,
        profile: "balanced",
        requestedCategories: ["BUTTOCKS_EXPOSED"],
        status: "completed",
        phase: "completed",
        scannedSeconds: 120,
        sourceDurationSeconds: 120,
        sampledFrames: 12,
        positiveFrames: 1,
        sourceFingerprint: `source:${fixture.videoId}`,
        analyzerRevision: "analyzer:v1",
        modelRevision: "model:v1",
        taxonomyRevision: "taxonomy:v1",
        configRevision: "config:v1",
        requestDigest: `request:${fixture.videoId}`,
        semanticGenerationKey: `semantic:${fixture.videoId}`,
        resultBookmarkCount: 1,
        isPublished: true,
        publishedAt: now,
        completedAt: now,
      })
      .returning({ id: contentAnalysisRunsTable.id });
    await db.insert(bookmarksTable).values({
      videoId: fixture.videoId,
      userId: ctx!.userId,
      timestampSeconds: 12,
      endTimestampSeconds: 14,
      peakTimestampSeconds: 13,
      origin: "automatic",
      analysisRunId: run!.id,
      name: "Automatic analysis bookmark",
    });

    const removed = await ctx!.authInject({
      method: "POST",
      url: "/api/videos/bulk/delete",
      payload: { ids: [fixture.videoId] },
    });
    expect(removed.statusCode, removed.body).toBe(200);

    const missing = await ctx!.authInject({
      method: "GET",
      url: `/api/videos/${fixture.videoId}`,
    });
    expect(missing.statusCode).toBe(404);
  });
});
