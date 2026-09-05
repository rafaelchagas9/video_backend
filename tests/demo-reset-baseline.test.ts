import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, rmSync, statSync } from "fs";
import { resolve } from "path";

process.env.NODE_ENV = "test";
process.env.POSTGRES_USER ||= "demo-reset-test";
process.env.POSTGRES_PASSWORD ||= "demo-reset-test";
process.env.SESSION_SECRET ||=
  "demo-reset-session-secret-at-least-32-characters";

const databasePath = `/tmp/conversor-video-demo-reset-${process.pid}.sqlite`;
const baselinePath = `${databasePath}.baseline`;
let demo: typeof import("@/database/demo");

function removeDatabases(): void {
  for (const path of [
    databasePath,
    `${databasePath}-shm`,
    `${databasePath}-wal`,
    baselinePath,
    `${baselinePath}-shm`,
    `${baselinePath}-wal`,
  ]) {
    rmSync(path, { force: true });
  }
}

describe("immutable demo SQLite baseline reset", () => {
  beforeAll(async () => {
    removeDatabases();
    demo = await import("@/database/demo");
    demo.setDemoDatabasePathForTests(databasePath);
    demo.importDemoJsonFile(
      resolve(process.cwd(), "demo_mode", "demo_mode.json"),
      { reset: true }
    );
    demo.importDemoArtworkManifestFile(
      resolve(process.cwd(), "demo_mode", "artwork", "manifest.json")
    );
    demo.createDemoBaselineSnapshot();
  });

  afterAll(() => {
    demo.setDemoDatabasePathForTests(null);
    removeDatabases();
  });

  it("fully restores catalog, relationships, artwork, and resources", () => {
    expect(existsSync(baselinePath)).toBe(true);
    expect(statSync(baselinePath).mode & 0o222).toBe(0);

    const sqlite = demo.getDemoSqlite();
    const reviewVideoId = sqlite
      .query<{ id: number }, []>(
        `SELECT v.id FROM demo_videos v
         WHERE v.studio_absence_confirmed_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM demo_video_studios vs WHERE vs.video_id = v.id
           )
         ORDER BY v.id LIMIT 1`
      )
      .get()!.id;
    const original = {
      reviewVideoId,
      videoTitle: sqlite
        .query<
          { title: string },
          []
        >("SELECT title FROM demo_videos WHERE id = 1")
        .get()!.title,
      creatorCount: sqlite
        .query<
          { count: number },
          []
        >("SELECT COUNT(*) AS count FROM demo_creators")
        .get()!.count,
      creator42: sqlite
        .query<
          { name: string },
          []
        >("SELECT name FROM demo_creators WHERE id = 42")
        .get()!.name,
      videoCount: sqlite
        .query<
          { count: number },
          []
        >("SELECT COUNT(*) AS count FROM demo_videos")
        .get()!.count,
      tagCount: sqlite
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM demo_tags")
        .get()!.count,
      studioName: sqlite
        .query<
          { name: string },
          []
        >("SELECT name FROM demo_studios WHERE id = 1")
        .get()!.name,
      artworkTitle: sqlite
        .query<
          { title: string },
          []
        >("SELECT title FROM demo_artwork WHERE video_id = 1")
        .get()!.title,
      artworkCount: sqlite
        .query<
          { count: number },
          []
        >("SELECT COUNT(*) AS count FROM demo_artwork")
        .get()!.count,
      artworkAssetCount: sqlite
        .query<
          { count: number },
          []
        >("SELECT COUNT(*) AS count FROM demo_artwork_assets")
        .get()!.count,
    };
    const scenarioTitles = sqlite
      .query<{ title: string }, []>(
        "SELECT title FROM demo_videos WHERE id BETWEEN 1 AND 5 ORDER BY id"
      )
      .all()
      .map(({ title }) => title);
    expect(scenarioTitles).toEqual([
      expect.stringContaining("Demo: Empty analysis"),
      expect.stringContaining("Demo: Single analysis moment"),
      expect.stringContaining("Demo: Typical analysis moments"),
      expect.stringContaining("Demo: Dense analysis moments"),
      expect.stringContaining("Demo: Stress-test analysis moments"),
    ]);
    const seededAnalysisRuns = sqlite
      .query<
        { count: number },
        []
      >("SELECT COUNT(*) AS count FROM demo_resources WHERE kind='content-analysis-run'")
      .get()!.count;
    const seededAutomaticBookmarks = sqlite
      .query<
        { count: number },
        []
      >("SELECT COUNT(*) AS count FROM demo_bookmarks WHERE origin='automatic'")
      .get()!.count;
    const seededBookmarksByVideo = sqlite
      .query<{ video_id: number; count: number }, []>(
        `SELECT video_id, COUNT(*) AS count
         FROM demo_bookmarks
         WHERE origin='automatic' AND video_id BETWEEN 1 AND 5
         GROUP BY video_id
         ORDER BY video_id`
      )
      .all();
    expect(seededAnalysisRuns).toBe(5);
    expect(seededAutomaticBookmarks).toBe(117);
    expect(seededBookmarksByVideo).toEqual([
      { video_id: 2, count: 1 },
      { video_id: 3, count: 8 },
      { video_id: 4, count: 28 },
      { video_id: 5, count: 80 },
    ]);

    sqlite.run("UPDATE demo_videos SET title = ? WHERE id = 1", [
      "Runtime-mutated title",
    ]);
    sqlite.run(
      "UPDATE demo_videos SET studio_absence_confirmed_at = ? WHERE id = ?",
      ["2026-08-01T00:00:00.000Z", reviewVideoId]
    );
    sqlite.run("DELETE FROM demo_creators WHERE id = 42");
    sqlite.run("DELETE FROM demo_videos WHERE id = 132");
    sqlite.run("UPDATE demo_studios SET name = ? WHERE id = 1", [
      "Runtime-mutated studio",
    ]);
    sqlite.run(
      `INSERT INTO demo_tags
       (id, name, parent_id, description, color, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        999,
        "Runtime-created tag",
        null,
        null,
        null,
        "2026-08-01T00:00:00.000Z",
        "2026-08-01T00:00:00.000Z",
      ]
    );
    sqlite.run(
      `INSERT INTO demo_creators
       (id, name, description, profile_picture_path, main_picture_path,
        face_thumbnail_path, extra_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        999,
        "Runtime-created creator",
        null,
        null,
        null,
        null,
        null,
        "2026-08-01T00:00:00.000Z",
        "2026-08-01T00:00:00.000Z",
      ]
    );
    sqlite.run("UPDATE demo_artwork SET title = ? WHERE video_id = 1", [
      "Runtime artwork title",
    ]);
    sqlite.run("DELETE FROM demo_artwork_assets WHERE video_id = 2");
    sqlite.run("DELETE FROM demo_artwork WHERE video_id = 2");
    sqlite.run("DELETE FROM demo_artwork_assets WHERE video_id = 3");
    sqlite.run("DELETE FROM demo_artwork WHERE video_id = 3");
    sqlite.run(
      `INSERT INTO demo_artwork
       (video_id, title, status, palette_json, generated_at)
       VALUES (?, ?, ?, ?, ?)`,
      [
        3,
        "Runtime-generated artwork",
        "ready",
        JSON.stringify({ dominant: "#123456" }),
        "2026-08-01T00:00:00.000Z",
      ]
    );
    demo.demoRepository.putResource("conversion-job", 777, {
      id: 777,
      status: "pending",
    });
    demo.demoRepository.putResource("edit-job", 888, {
      id: 888,
      status: "running",
      progress: 70,
    });
    demo.demoRepository.putResource("edit-job-simulation", 888, {
      outcome: "success",
    });
    sqlite.run(
      `INSERT INTO demo_bookmark_categories
       (key, name, kind, user_id, created_at, updated_at)
       VALUES (?, ?, 'custom', ?, ?, ?)`,
      [
        "runtime-custom",
        "Runtime custom",
        1,
        "2026-08-01T00:00:00.000Z",
        "2026-08-01T00:00:00.000Z",
      ]
    );
    sqlite.run(
      `DELETE FROM demo_bookmarks
       WHERE id = (
         SELECT id FROM demo_bookmarks
         WHERE origin = 'automatic' AND video_id = 5
         ORDER BY id
         LIMIT 1
       )`
    );

    // Additive migrations may make the live schema newer than an immutable
    // baseline captured by the previous release. Missing nullable columns must
    // take their defaults instead of making startup fail on column counts.
    sqlite.exec("ALTER TABLE demo_collections ADD COLUMN future_nullable TEXT");

    demo.resetDemoRuntimeState();

    expect(
      sqlite
        .query<
          { future_nullable: string | null },
          []
        >("SELECT future_nullable FROM demo_collections WHERE id = 1")
        .get()?.future_nullable
    ).toBeNull();
    expect(
      sqlite
        .query<
          { count: number },
          []
        >("SELECT COUNT(*) AS count FROM demo_bookmark_categories WHERE kind='system'")
        .get()!.count
    ).toBe(11);
    expect(
      sqlite
        .query<
          { count: number },
          []
        >("SELECT COUNT(*) AS count FROM demo_bookmark_categories WHERE kind='custom'")
        .get()!.count
    ).toBe(0);
    expect(
      sqlite
        .query<
          { count: number },
          []
        >("SELECT COUNT(*) AS count FROM demo_resources WHERE kind='content-analysis-run'")
        .get()!.count
    ).toBe(seededAnalysisRuns);
    expect(
      sqlite
        .query<
          { count: number },
          []
        >("SELECT COUNT(*) AS count FROM demo_bookmarks WHERE origin='automatic'")
        .get()!.count
    ).toBe(seededAutomaticBookmarks);

    expect(
      sqlite
        .query<
          { title: string },
          []
        >("SELECT title FROM demo_videos WHERE id = 1")
        .get()!.title
    ).toBe(original.videoTitle);
    expect(
      sqlite
        .query<
          { studio_absence_confirmed_at: string | null },
          [number]
        >("SELECT studio_absence_confirmed_at FROM demo_videos WHERE id = ?")
        .get(original.reviewVideoId)?.studio_absence_confirmed_at
    ).toBeNull();
    expect(
      demo.demoRepository.getVideoById(original.reviewVideoId)
        .studio_assignment_status
    ).toBe("unknown");
    expect(
      sqlite
        .query<
          { count: number },
          []
        >("SELECT COUNT(*) AS count FROM demo_creators")
        .get()!.count
    ).toBe(original.creatorCount);
    expect(
      sqlite
        .query<
          { count: number },
          []
        >("SELECT COUNT(*) AS count FROM demo_videos")
        .get()!.count
    ).toBe(original.videoCount);
    expect(
      sqlite
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM demo_tags")
        .get()!.count
    ).toBe(original.tagCount);
    expect(
      sqlite
        .query<
          { name: string },
          []
        >("SELECT name FROM demo_studios WHERE id = 1")
        .get()!.name
    ).toBe(original.studioName);
    expect(
      sqlite
        .query<
          { name: string },
          []
        >("SELECT name FROM demo_creators WHERE id = 42")
        .get()!.name
    ).toBe(original.creator42);
    expect(
      sqlite
        .query<
          { count: number },
          []
        >("SELECT COUNT(*) AS count FROM demo_creators WHERE id = 999")
        .get()!.count
    ).toBe(0);
    expect(
      sqlite
        .query<
          { title: string },
          []
        >("SELECT title FROM demo_artwork WHERE video_id = 1")
        .get()!.title
    ).toBe(original.artworkTitle);
    expect(
      sqlite
        .query<
          { count: number },
          []
        >("SELECT COUNT(*) AS count FROM demo_artwork")
        .get()!.count
    ).toBe(original.artworkCount);
    expect(
      sqlite
        .query<
          { count: number },
          []
        >("SELECT COUNT(*) AS count FROM demo_artwork_assets")
        .get()!.count
    ).toBe(original.artworkAssetCount);
    expect(demo.demoRepository.getResource("conversion-job", 777)).toBeNull();
    expect(demo.demoRepository.getResource("edit-job", 888)).toBeNull();
    expect(
      demo.demoRepository.getResource("edit-job-simulation", 888)
    ).toBeNull();
  });

  it("preserves mutations across reopen until an explicit reset", () => {
    demo
      .getDemoSqlite()
      .run("UPDATE demo_videos SET title = ? WHERE id = 1", [
        "Manual-mode persisted title",
      ]);
    demo.closeDemoDatabase();
    expect(
      demo
        .getDemoSqlite()
        .query<
          { title: string },
          []
        >("SELECT title FROM demo_videos WHERE id = 1")
        .get()!.title
    ).toBe("Manual-mode persisted title");

    demo.resetDemoRuntimeState();
    expect(
      demo
        .getDemoSqlite()
        .query<
          { title: string },
          []
        >("SELECT title FROM demo_videos WHERE id = 1")
        .get()!.title
    ).not.toBe("Manual-mode persisted title");
  });

  it("restores an older baseline that predates additive demo tables", () => {
    demo.closeDemoDatabase();
    chmodSync(baselinePath, 0o644);
    const baseline = new Database(baselinePath, { strict: true });
    try {
      baseline.exec("DROP TABLE demo_studio_aliases");
    } finally {
      baseline.close(false);
      chmodSync(baselinePath, 0o444);
    }

    demo.resetDemoRuntimeState();

    const sqlite = demo.getDemoSqlite();
    expect(
      sqlite
        .query<
          { count: number },
          []
        >("SELECT COUNT(*) AS count FROM demo_studio_aliases")
        .get()!.count
    ).toBeGreaterThan(0);
  });
});
