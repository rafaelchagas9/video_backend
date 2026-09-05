import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getDemoSqlite,
  initializeDemoDatabase,
  setDemoDatabasePathForTests,
} from "@/database/demo";
import { env } from "@/config/env";
import { videosService } from "@/modules/videos/videos.service";

const root = mkdtempSync(join(tmpdir(), "demo-random-regression-"));
const originalDemoMode = env.DEMO_MODE;
beforeAll(() => {
  env.DEMO_MODE = true;
  setDemoDatabasePathForTests(join(root, "test.sqlite"));
  initializeDemoDatabase();
  const db = getDemoSqlite();
  db.run(
    "INSERT INTO demo_creators (id,name,created_at,updated_at) VALUES (1,'Synthetic creator','2026-01-01','2026-01-01')"
  );
  db.run(
    "INSERT INTO demo_tags (id,name,created_at,updated_at) VALUES (1,'Unique selection','2026-01-01','2026-01-01')"
  );
  for (let id = 1; id <= 160; id++) {
    db.run(
      `INSERT INTO demo_videos (id,directory_id,file_path,file_name,file_size_bytes,is_available,indexed_at,created_at,updated_at) VALUES (?,1,'/synthetic/' || ? || '.mp4',? || '.mp4',1,1,'2026-01-01','2026-01-01','2026-01-01')`,
      [id, id, id]
    );
    if (id <= 150) db.run("INSERT INTO demo_video_creators VALUES (?,1)", [id]);
  }
  db.run("INSERT INTO demo_video_tags VALUES (1,1)");
});
afterAll(() => {
  env.DEMO_MODE = originalDemoMode;
  setDemoDatabasePathForTests(null);
  rmSync(root, { recursive: true, force: true });
});

describe("demo random-video selection", () => {
  it("samples every matching video beyond the first100 and preserves filters", async () => {
    const result = await videosService.getRandomVideo(1, {
      creatorIds: [1],
      matchMode: "all",
      limit: 150,
    });
    expect(Array.isArray(result)).toBe(true);
    if (!Array.isArray(result))
      throw new Error("Expected an array for an explicit limit");
    expect(result).toHaveLength(150);
    expect(result.map((video) => video.id).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 150 }, (_, index) => index + 1)
    );
  });

  it("returns one video without hydrating the matching catalog", async () => {
    const queries = spyOn(getDemoSqlite(), "query");
    try {
      const result = await videosService.getRandomVideo(1, { creatorIds: [1] });
      expect(Array.isArray(result)).toBe(false);
      if (Array.isArray(result))
        throw new Error("Expected a single video without a limit");
      expect(result.id).toBeGreaterThanOrEqual(1);
      expect(result.id).toBeLessThanOrEqual(150);
      expect(queries.mock.calls.length).toBeLessThan(50);
    } finally {
      queries.mockRestore();
    }
  });

  it("preserves single-match and no-match behavior", async () => {
    const result = await videosService.getRandomVideo(1, { tagIds: [1] });
    expect(result).toMatchObject({ id: 1 });
    await expect(
      videosService.getRandomVideo(1, { creatorIds: [999999] })
    ).rejects.toThrow("No matching videos found");
  });
});
