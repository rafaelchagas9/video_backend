import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { collectionInput } from "@/modules/creator-collections/creator-collections.domain";
const path = `/tmp/kura-creator-collections-${process.pid}.sqlite`;
let service: typeof import("@/modules/creator-collections/creator-collections.service").creatorCollectionsService;
let creatorId = 0,
  videoId = 0;
let originalMode = false;
describe("creator collections persistence in isolated demo database", () => {
  beforeAll(async () => {
    const { env } = await import("@/config/env");
    originalMode = env.DEMO_MODE;
    env.DEMO_MODE = true;
    const demo = await import("@/database/demo");
    demo.setDemoDatabasePathForTests(path);
    demo.importDemoJsonFile(undefined, { reset: true });
    const sqlite = demo.getDemoSqlite();
    const creator = sqlite
      .query<{ id: number }, []>(
        "INSERT INTO demo_creators(name,created_at,updated_at) VALUES ('Collection test','2026-01-01','2026-01-01') RETURNING id"
      )
      .get()!;
    creatorId = creator.id;
    videoId = sqlite
      .query<{ id: number }, []>("SELECT id FROM demo_videos LIMIT 1")
      .get()!.id;
    sqlite
      .query(
        "INSERT INTO demo_video_creators(video_id,creator_id) VALUES (?,?)"
      )
      .run(videoId, creatorId);
    sqlite
      .query(
        "INSERT INTO demo_creator_gallery(id,creator_id,label,file_path,is_profile_picture,is_main_picture,created_at,updated_at) VALUES (1,?,'Essay cover','demo-assets/example.jpg',0,0,'2026-01-01','2026-01-01')"
      )
      .run(creatorId);
    service = (
      await import("@/modules/creator-collections/creator-collections.service")
    ).creatorCollectionsService;
  });
  afterAll(async () => {
    const demo = await import("@/database/demo");
    demo.setDemoDatabasePathForTests(null);
    for (const suffix of ["", "-wal", "-shm"])
      rmSync(path + suffix, { force: true });
    const { env } = await import("@/config/env");
    env.DEMO_MODE = originalMode;
  });
  test("persists source-linked ordered set without modifying the gallery or videos", async () => {
    const before = await service.list(creatorId);
    expect(before).toEqual({ revision: 0, sets: [] });
    const saved = await service.save(
      creatorId,
      collectionInput.parse({
        title: "Creator essay",
        release_date: "2026-09-01",
        source_url: "https://example.org/profile",
        gallery_ids: [1],
        video_ids: [videoId],
      }),
      0
    );
    expect(await service.list(creatorId)).toEqual(saved);
    const demo = await import("@/database/demo");
    demo.closeDemoDatabase();
    expect((await service.list(creatorId)).sets[0]!.source_url).toBe(
      "https://example.org/profile"
    );
    expect(
      demo
        .getDemoSqlite()
        .query<{ count: number }, [number]>(
          "SELECT COUNT(*) as count FROM demo_creator_gallery WHERE creator_id=?"
        )
        .get(creatorId)!.count
    ).toBe(1);
  });
  test("rejects stale saves at storage boundary", async () => {
    const doc = await service.list(creatorId);
    await expect(
      service.save(
        creatorId,
        collectionInput.parse({ title: "Do not overwrite" }),
        doc.revision - 1
      )
    ).rejects.toThrow("changed");
    expect((await service.list(creatorId)).sets[0]!.title).toBe(
      "Creator essay"
    );
  });
  test("rejects membership from another creator and leaves revision untouched", async () => {
    const doc = await service.list(creatorId);
    await expect(
      service.save(
        creatorId,
        collectionInput.parse({ title: "Wrong image", gallery_ids: [999999] }),
        doc.revision
      )
    ).rejects.toThrow("image");
    expect((await service.list(creatorId)).revision).toBe(doc.revision);
  });
});
