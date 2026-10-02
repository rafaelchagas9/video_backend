import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  createTestApp,
  seedVideoFixture,
  type TestApp,
} from "../helpers/test-app";

// The helper provisions and validates a throwaway Postgres container BEFORE any
// database-bound imports. Every write below targets that temporary database.
describe("creator collection lifecycle on isolated PostgreSQL", () => {
  let ctx: TestApp;
  beforeAll(async () => {
    ctx = await createTestApp();
  }, 120000);
  afterAll(async () => {
    await ctx?.close();
  });
  it("actual creator merge preserves both documents, IDs/order and audit and invalidates old revisions", async () => {
    const { db } = await import("@/config/drizzle");
    const {
      creatorsTable,
      creatorGalleryMediaTable,
      videoCreatorsTable,
      creatorMergesTable,
      appSettingsTable,
    } = await import("@/database/schema");
    const { creatorCollectionsService: service } =
      await import("@/modules/creator-collections/creator-collections.service");
    const { collectionInput } =
      await import("@/modules/creator-collections/creator-collections.domain");
    const { creatorsMergeService } =
      await import("@/modules/creators/creators.merge.service");
    const [target, source] = await db
      .insert(creatorsTable)
      .values([{ name: "Lifecycle canonical" }, { name: "Lifecycle source" }])
      .returning();
    const images = await db
      .insert(creatorGalleryMediaTable)
      .values([
        { creatorId: target.id, filePath: "/tmp/lifecycle-target.png" },
        { creatorId: source.id, filePath: "/tmp/lifecycle-source-1.png" },
        { creatorId: source.id, filePath: "/tmp/lifecycle-source-2.png" },
      ])
      .returning();
    const video = await seedVideoFixture("lifecycle-merge-video.mp4");
    await db.insert(videoCreatorsTable).values([
      { creatorId: target.id, videoId: video.videoId },
      { creatorId: source.id, videoId: video.videoId },
    ]);
    const into = await service.save(
      target.id,
      collectionInput.parse({
        title: "Target edition",
        gallery_ids: [images[0].id],
        video_ids: [video.videoId],
      }),
      0
    );
    const from = await service.save(
      source.id,
      collectionInput.parse({
        title: "Source edition",
        gallery_ids: [images[2].id, images[1].id],
        video_ids: [video.videoId],
        source_url: "https://example.test/source",
      }),
      0
    );
    await creatorsMergeService.mergeCreators(
      source.id,
      target.id,
      "isolated collection fixture"
    );
    const merged = await service.list(target.id);
    expect(merged.sets.map((s) => s.id)).toEqual([
      into.sets[0].id,
      from.sets[0].id,
    ]);
    expect(merged.sets[1].gallery_ids).toEqual([images[2].id, images[1].id]);
    expect(merged.sets[1].source_url).toBe("https://example.test/source");
    expect(merged.revision).toBe(2);
    expect(
      await db
        .select()
        .from(appSettingsTable)
        .where(eq(appSettingsTable.key, `creator_collection_sets:${source.id}`))
    ).toHaveLength(0);
    const [audit] = await db
      .select()
      .from(creatorMergesTable)
      .where(eq(creatorMergesTable.fromCreatorId, source.id));
    expect(audit.snapshot).toMatchObject({
      collectionMerge: { source: from, target: into },
    });
    await expect(
      service.save(
        target.id,
        collectionInput.parse(into.sets[0]),
        into.revision,
        into.sets[0].id
      )
    ).rejects.toThrow("changed");
    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/creator-collections/${target.id}`,
      headers: { cookie: ctx.authCookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.sets[1].id).toBe(from.sets[0].id);
    await db
      .delete(creatorGalleryMediaTable)
      .where(eq(creatorGalleryMediaTable.id, images[2].id));
    await db
      .delete(videoCreatorsTable)
      .where(
        and(
          eq(videoCreatorsTable.creatorId, target.id),
          eq(videoCreatorsTable.videoId, video.videoId)
        )
      );
    const listed = await service.list(target.id);
    expect(listed.revision).toBe(2);
    expect(listed.sets[1].gallery_ids).toEqual([images[1].id]);
    expect(listed.sets[1].removed_gallery_ids).toEqual([images[2].id]);
    expect(listed.sets[1].removed_video_ids).toEqual([video.videoId]);
    const updated = await service.save(
      target.id,
      collectionInput.parse({
        ...listed.sets[1],
        title: "Renamed after removals",
      }),
      listed.revision,
      listed.sets[1].id
    );
    expect(updated.sets[1].removed_gallery_ids).toEqual([images[2].id]);
    expect(updated.sets[1].title).toBe("Renamed after removals");
    const concurrent = await Promise.allSettled([
      service.save(
        target.id,
        collectionInput.parse({ ...updated.sets[1], title: "A" }),
        updated.revision,
        updated.sets[1].id
      ),
      service.save(
        target.id,
        collectionInput.parse({ ...updated.sets[1], title: "B" }),
        updated.revision,
        updated.sets[1].id
      ),
    ]);
    expect(concurrent.filter((v) => v.status === "fulfilled")).toHaveLength(1);
    expect(concurrent.filter((v) => v.status === "rejected")).toHaveLength(1);
  });
  it("waits for concurrent gallery deletion and rejects a newly introduced missing member", async () => {
    const { db } = await import("@/config/drizzle");
    const { creatorsTable, creatorGalleryMediaTable } =
      await import("@/database/schema");
    const { creatorCollectionsService: service } =
      await import("@/modules/creator-collections/creator-collections.service");
    const { collectionInput } =
      await import("@/modules/creator-collections/creator-collections.domain");
    const [creator] = await db
      .insert(creatorsTable)
      .values({ name: "Concurrent collection fixture" })
      .returning();
    const [image] = await db
      .insert(creatorGalleryMediaTable)
      .values({
        creatorId: creator.id,
        filePath: "/tmp/synthetic-concurrent.png",
      })
      .returning();
    let release!: () => void, locked!: () => void;
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const unblock = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deletion = db.transaction(async (tx) => {
      await tx
        .delete(creatorGalleryMediaTable)
        .where(eq(creatorGalleryMediaTable.id, image.id));
      locked();
      await unblock;
    });
    await ready;
    let settled = false;
    const save = service
      .save(
        creator.id,
        collectionInput.parse({
          title: "Must reject missing member",
          gallery_ids: [image.id],
        }),
        0
      )
      .finally(() => {
        settled = true;
      });
    // Attach a rejection handler immediately so a failing assertion cannot leak
    // an unhandled promise while the competing transaction is held open.
    const result = save.then(
      () => "saved",
      (error) => error.message
    );
    try {
      await Bun.sleep(30);
      expect(settled).toBe(false);
    } finally {
      release();
      await deletion;
    }
    expect(await result).toContain("image");
    expect((await service.list(creator.id)).sets).toHaveLength(0);
  });
});
