import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  demoRepository,
  getDemoSqlite,
  initializeDemoDatabase,
  setDemoDatabasePathForTests,
} from "@/database/demo";
const root = mkdtempSync(join(tmpdir(), "demo-query-regression-"));
beforeAll(() => {
  setDemoDatabasePathForTests(join(root, "test.sqlite"));
  initializeDemoDatabase();
  const db = getDemoSqlite();
  for (const id of [1, 2, 3])
    db.run(
      `INSERT INTO demo_videos (id, directory_id, file_path, file_name, duration_seconds, file_size_bytes, width, height, codec, is_available, indexed_at, created_at, updated_at) VALUES (?, ?, '/synthetic/' || ? || '.mp4', ? || '.mp4', ?, 2048, 1920, 1080, 'h264', ?, '2026-01-01', '2026-01-01', '2026-01-01')`,
      [id, id === 1 ? 1 : 2, id, id, id * 100, id === 3 ? 0 : 1]
    );
  for (const id of [1, 2])
    db.run(
      "INSERT INTO demo_creators (id, name, created_at, updated_at) VALUES (?, ?, '2026-01-01', '2026-01-01')",
      [id, `Creator ${id}`]
    );
  db.exec(
    "INSERT INTO demo_video_creators VALUES (1,1),(1,2),(2,1); INSERT INTO demo_favorites (user_id,video_id,added_at) VALUES (1,1,'2026-01-01'); INSERT INTO demo_ratings (video_id,rating,rated_at) VALUES (1,5,'2026-01-01'),(1,3,'2026-01-01'),(2,2,'2026-01-01');"
  );
  db.exec(
    "INSERT INTO demo_tags (id,name,parent_id,created_at,updated_at) VALUES (1,'Parent',NULL,'2026-01-01','2026-01-01'),(2,'Child',1,'2026-01-01','2026-01-01'),(3,'Sibling',1,'2026-01-01','2026-01-01'); INSERT INTO demo_video_tags VALUES(1,2),(2,3);"
  );
});
afterAll(() => {
  setDemoDatabasePathForTests(null);
  rmSync(root, { recursive: true, force: true });
});
const ids = (options: Record<string, unknown>) =>
  demoRepository.getVideos(options).data.map((video) => video.id);
describe("demo video query parity", () => {
  it("filters availability, favorites and directories before counting", () => {
    expect(ids({ directory_id: 2 })).toEqual([2]);
    expect(ids({ isAvailable: false })).toEqual([3]);
    expect(ids({ isFavorite: true })).toEqual([1]);
  });
  it("respects all-match semantics and average rating", () => {
    expect(ids({ creatorIds: [1, 2], matchMode: "all" })).toEqual([1]);
    expect(ids({ minRating: 3, maxRating: 4 })).toEqual([1]);
  });
  it("matches each selected tag subtree without requiring every descendant", () => {
    expect(ids({ tagIds: [1, 2], matchMode: "all" })).toEqual([1]);
    expect(
      ids({ tagIds: [1], matchMode: "all", sort: "file_name", order: "asc" })
    ).toEqual([1, 2]);
  });
  it("filters metadata and honors full-path search", () => {
    expect(ids({ minDuration: 150, maxFileSize: 3000, codec: "H264" })).toEqual(
      [2]
    );
    expect(
      ids({
        search: "synthetic",
        searchFullPath: true,
        sort: "file_name",
        order: "asc",
      })
    ).toEqual([1, 2]);
    expect(ids({ hasCreator: false })).toEqual([]);
  });
  it("uses stable requested ordering and accurate pagination", () => {
    const page = demoRepository.getVideos({
      sort: "duration_seconds",
      order: "desc",
      limit: 1,
      page: 2,
    });
    expect(page.data.map((video) => video.id)).toEqual([1]);
    expect(page.pagination).toMatchObject({ total: 2, totalPages: 2 });
  });
  it("hydrates only the requested page instead of the entire library", () => {
    for (let id = 4; id < 34; id++)
      getDemoSqlite().run(
        `INSERT INTO demo_videos (id,directory_id,file_path,file_name,file_size_bytes,is_available,indexed_at,created_at,updated_at) VALUES (?,1,'/synthetic/' || ? || '.mp4',? || '.mp4',1,1,'2026-01-01','2026-01-01','2026-01-01')`,
        [id, id, id]
      );
    const queries = spyOn(getDemoSqlite(), "query");
    try {
      expect(ids({ ids: [1], limit: 1 })).toEqual([1]);
      expect(queries.mock.calls.length).toBeLessThan(50);
    } finally {
      queries.mockRestore();
    }
  });
});
