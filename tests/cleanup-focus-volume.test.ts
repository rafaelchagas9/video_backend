import { beforeAll, afterAll, describe, test, expect } from "bun:test";
import { rmSync } from "node:fs";
process.env.NODE_ENV = "test";
const path = `/tmp/kura-focus-volume-${process.pid}.sqlite`;
let mode = false;
let service: typeof import("@/modules/cleanup/cleanup.service").cleanupService;
let groupId = 0;
describe("storage review volume and completed group", () => {
  beforeAll(async () => {
    const { env } = await import("@/config/env");
    mode = env.DEMO_MODE;
    env.DEMO_MODE = true;
    const demo = await import("@/database/demo");
    demo.setDemoDatabasePathForTests(path);
    demo.importDemoJsonFile(undefined, { reset: true });
    const db = demo.getDemoSqlite();
    groupId = db
      .query<{ id: number }, []>(
        "INSERT INTO demo_creators(name,created_at,updated_at) VALUES ('Volume test','2026-01-01','2026-01-01') RETURNING id"
      )
      .get()!.id;
    const template = db
      .query<Record<string, string | number | null>, []>(
        "SELECT * FROM demo_videos LIMIT 1"
      )
      .get()!;
    const fields = Object.keys(template);
    db.transaction(() => {
      for (let index = 0; index < 1005; index++) {
        const row = {
          ...template,
          id: 1000000 + index,
          file_name: `volume-${index}.mp4`,
          file_path: `video/volume-${index}.mp4`,
          file_size_bytes: index + 1,
        };
        db.run(
          `INSERT INTO demo_videos (${fields.join(",")}) VALUES (${fields.map(() => "?").join(",")})`,
          fields.map((key) => row[key as keyof typeof row])
        );
        db.run(
          "INSERT INTO demo_video_creators(video_id,creator_id) VALUES (?,?)",
          [row.id, groupId]
        );
      }
    })();
    service = (await import("@/modules/cleanup/cleanup.service"))
      .cleanupService;
  });
  afterAll(async () => {
    const demo = await import("@/database/demo");
    demo.setDemoDatabasePathForTests(null);
    for (const suffix of ["", "-wal", "-shm"])
      rmSync(path + suffix, { force: true });
    (await import("@/config/env")).env.DEMO_MODE = mode;
  });
  test("includes groups spanning over one thousand videos and filters before pagination", async () => {
    const page = await service.listCandidates(1, {
      creator_id: groupId,
      disposition: "unreviewed",
      limit: 3,
      offset: 1002,
    });
    expect(page.total).toBe(1005);
    expect(page.data).toHaveLength(3);
    expect(
      page.data.every((video) =>
        video.creators.some((creator) => creator.id === groupId)
      )
    ).toBe(true);
    const group = (await service.focus(1)).find(
      (group) => group.kind === "creator" && group.id === groupId
    )!;
    expect(group.remaining_count).toBe(1005);
    expect(group.remaining_bytes).toBe((1005 * 1006) / 2);
  });
  test("retains completed group for revisiting saved decisions", async () => {
    const db = (await import("@/database/demo")).getDemoSqlite();
    const creator = db
      .query<{ id: number }, []>(
        "INSERT INTO demo_creators(name,created_at,updated_at) VALUES ('Completed test','2026-01-01','2026-01-01') RETURNING id"
      )
      .get()!;
    db.run(
      "INSERT INTO demo_video_creators(video_id,creator_id) VALUES (?,?)",
      [1000000, creator.id]
    );
    await service.saveReview(1, 1000000, "keep", 0);
    const group = (await service.focus(1)).find(
      (group) => group.kind === "creator" && group.id === creator.id
    )!;
    expect(group.remaining_count).toBe(0);
    expect(group.reviewed_count).toBe(1);
    const saved = await service.listCandidates(1, {
      creator_id: creator.id,
      disposition: "keep",
      limit: 3,
      offset: 0,
    });
    expect(saved.total).toBe(1);
  });
});
