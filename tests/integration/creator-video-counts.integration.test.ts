import { afterAll, beforeAll, expect, it } from "bun:test";
import { eq, sql } from "drizzle-orm";
import {
  createTestApp,
  seedVideoFixture,
  type TestApp,
} from "../helpers/test-app";

let ctx: TestApp | undefined;
beforeAll(async () => {
  ctx = await createTestApp();
}, 120_000);
afterAll(async () => {
  await ctx?.close();
});

it("excludes legacy orphan links from creator counts, ordering and filters", async () => {
  const { db } = await import("@/config/drizzle");
  const { creatorsTable, videoCreatorsTable, videosTable } =
    await import("@/database/schema");
  const { creatorsService } =
    await import("@/modules/creators/creators.service");
  const [creator, other] = await db
    .insert(creatorsTable)
    .values([{ name: "Count Regression A" }, { name: "Count Regression B" }])
    .returning();
  const kept = await seedVideoFixture("count-kept.mp4");
  const removed = await seedVideoFixture("count-removed.mp4");
  const extra = await seedVideoFixture("count-extra.mp4");
  await db.insert(videoCreatorsTable).values([
    { creatorId: creator!.id, videoId: kept.videoId },
    { creatorId: creator!.id, videoId: removed.videoId },
    { creatorId: creator!.id, videoId: extra.videoId },
    { creatorId: other!.id, videoId: kept.videoId },
    { creatorId: other!.id, videoId: extra.videoId },
  ]);
  // Reproduce the legacy schema only in the disposable integration database.
  const constraints = await db.execute(sql`SELECT conname FROM pg_constraint
    WHERE conrelid = 'video_creators'::regclass AND confrelid = 'videos'::regclass`);
  for (const constraint of constraints) {
    await db.execute(
      sql`ALTER TABLE video_creators DROP CONSTRAINT ${sql.identifier(String(constraint.conname))}`
    );
  }
  await db.delete(videosTable).where(eq(videosTable.id, removed.videoId));
  await db.delete(videosTable).where(eq(videosTable.id, extra.videoId));
  const list = await creatorsService.list({
    search: "Count Regression",
    sort: "video_count",
    order: "asc",
  });
  // Both have one surviving video; ordering must use the ID tie-break, not raw links.
  expect(list.data.map((c) => [c.id, c.linked_video_count])).toEqual([
    [creator!.id, 1],
    [other!.id, 1],
  ]);
  const filtered = await creatorsService.list({
    search: "Count Regression",
    minVideoCount: 1,
    maxVideoCount: 1,
  });
  expect(filtered.pagination.total).toBe(2);
  expect(
    (
      await creatorsService.list({
        search: "Count Regression",
        minVideoCount: 2,
      })
    ).pagination.total
  ).toBe(0);
  expect(
    (await creatorsService.autocomplete("Count Regression")).map(
      (c) => c.linked_video_count
    )
  ).toEqual([1, 1]);
  const recent = await creatorsService.getRecent(100);
  expect(recent.find((c) => c.id === creator!.id)?.linked_video_count).toBe(1);
  const facets = await creatorsService.facets({
    search: "Count Regression",
    maxVideoCount: 1,
  });
  expect(facets.total).toBe(2);
  await db.delete(videosTable).where(eq(videosTable.id, kept.videoId));
  const empty = await creatorsService.list({
    search: "Count Regression",
    maxVideoCount: 0,
  });
  expect(empty.pagination.total).toBe(2);
  expect(empty.data.every((c) => c.linked_video_count === 0)).toBe(true);
  expect(
    empty.data.every((c) =>
      c.completeness.missing_fields.includes("linked_videos")
    )
  ).toBe(true);
});
