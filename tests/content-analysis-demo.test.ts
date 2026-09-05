import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { existsSync, unlinkSync } from "node:fs";

process.env.NODE_ENV = "test";
process.env.POSTGRES_USER ||= "test_user";
process.env.POSTGRES_PASSWORD ||= "test_password";
process.env.SESSION_SECRET ||=
  "content-analysis-demo-session-secret-at-least-32-characters";

const databasePath = `/tmp/conversor-video-content-analysis-demo-${process.pid}.sqlite`;
let originalDemoMode: boolean;
let env: typeof import("@/config/env").env;
let closeDemoDatabase: typeof import("@/database/demo").closeDemoDatabase;
let getDemoSqlite: typeof import("@/database/demo").getDemoSqlite;
let initializeDemoDatabase: typeof import("@/database/demo").initializeDemoDatabase;
let setDemoDatabasePathForTests: typeof import("@/database/demo").setDemoDatabasePathForTests;
let service: typeof import("@/modules/content-analysis/content-analysis.demo.service").demoContentAnalysisService;

function removeDatabaseFiles(): void {
  closeDemoDatabase();
  for (const suffix of ["", "-shm", "-wal"]) {
    const path = `${databasePath}${suffix}`;
    if (existsSync(path)) unlinkSync(path);
  }
}

beforeAll(async () => {
  ({ env } = await import("@/config/env"));
  ({
    closeDemoDatabase,
    getDemoSqlite,
    initializeDemoDatabase,
    setDemoDatabasePathForTests,
  } = await import("@/database/demo"));
  ({ demoContentAnalysisService: service } =
    await import("@/modules/content-analysis/content-analysis.demo.service"));
  originalDemoMode = env.DEMO_MODE;
});

beforeEach(() => {
  env.DEMO_MODE = true;
  setDemoDatabasePathForTests(databasePath);
  removeDatabaseFiles();
  initializeDemoDatabase();
  const timestamp = "2026-08-28T12:00:00.000Z";
  const insertVideo = getDemoSqlite().prepare(
    "INSERT INTO demo_videos (id,source_video_id,file_path,file_name,directory_id,file_size_bytes,duration_seconds,is_available,indexed_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
  );
  for (let id = 1; id <= 5; id += 1) {
    insertVideo.run(
      id,
      id,
      `demo_mode/video/synthetic-${id}.webm`,
      `synthetic-${id}.webm`,
      1,
      100,
      600,
      1,
      timestamp,
      timestamp,
      timestamp
    );
  }
});

afterEach(removeDatabaseFiles);
afterAll(() => {
  setDemoDatabasePathForTests(null);
  env.DEMO_MODE = originalDemoMode;
});

describe("demo content analysis", () => {
  it("persists and reuses a deterministic empty result without opening media or Python", async () => {
    const first = await service.start({
      videoId: 1,
      userId: 1,
      profile: "balanced",
      categories: ["BUTTOCKS_EXPOSED"],
    });
    const reused = await service.start({
      videoId: 1,
      userId: 1,
      profile: "balanced",
      categories: ["BUTTOCKS_EXPOSED"],
    });

    expect(first).toMatchObject({
      reused: false,
      run: {
        status: "completed",
        isPublished: true,
        resultBookmarkCount: 0,
        sampledFrames: 300,
        positiveFrames: 0,
        modelRevision: "demo-synthetic-findings-v1",
      },
    });
    expect(reused).toMatchObject({ reused: true, run: { id: first.run.id } });
    expect((await service.get(first.run.id, 1)).id).toBe(first.run.id);
    expect((await service.cancel(first.run.id, 1)).status).toBe("completed");
  });

  it("publishes the singleton, typical, dense, and stress scenario ranges", async () => {
    const expectedCounts = [1, 8, 28, 80];
    for (const [index, expectedCount] of expectedCounts.entries()) {
      const videoId = index + 2;
      const result = await service.start({
        videoId,
        userId: 1,
        profile: "balanced",
        categories: [
          "BUTTOCKS_EXPOSED",
          "FEMALE_BREAST_EXPOSED",
          "FEET_EXPOSED",
        ],
      });
      const bookmarks = getDemoSqlite()
        .query<
          {
            id: number;
            timestamp_seconds: number;
            peak_timestamp_seconds: number;
            end_timestamp_seconds: number;
          },
          [number]
        >(
          "SELECT id,timestamp_seconds,peak_timestamp_seconds,end_timestamp_seconds FROM demo_bookmarks WHERE video_id=? AND origin='automatic' ORDER BY timestamp_seconds,id"
        )
        .all(videoId);

      expect(result.run.resultBookmarkCount).toBe(expectedCount);
      expect(result.run.resultEventCount).toBe(expectedCount);
      expect(result.run.positiveFrames).toBeGreaterThan(0);
      expect(result.run.sampledFrames).toBeGreaterThan(
        result.run.positiveFrames
      );
      expect(bookmarks).toHaveLength(expectedCount);
      expect(
        bookmarks.every(
          (bookmark) =>
            bookmark.timestamp_seconds <= bookmark.peak_timestamp_seconds &&
            bookmark.peak_timestamp_seconds <= bookmark.end_timestamp_seconds
        )
      ).toBe(true);
      expect(
        bookmarks.every(
          (bookmark, bookmarkIndex) =>
            bookmarkIndex === 0 ||
            bookmarks[bookmarkIndex - 1]!.end_timestamp_seconds <
              bookmark.timestamp_seconds
        )
      ).toBe(true);
    }

    const assignmentCount = getDemoSqlite()
      .query<
        { count: number },
        []
      >("SELECT COUNT(*) AS count FROM demo_bookmark_category_assignments")
      .get()!.count;
    expect(assignmentCount).toBeGreaterThan(117);
  });

  it("forced reanalysis replaces untouched automatic bookmarks and preserves edited and manual ones", async () => {
    const first = await service.start({
      videoId: 3,
      userId: 1,
      profile: "balanced",
      categories: ["BUTTOCKS_EXPOSED", "FEMALE_BREAST_EXPOSED"],
    });
    const firstAutomatic = getDemoSqlite()
      .query<
        { id: number },
        [number]
      >("SELECT id FROM demo_bookmarks WHERE analysis_run_id=? ORDER BY id LIMIT 1")
      .get(first.run.id)!;
    getDemoSqlite().run(
      "UPDATE demo_bookmarks SET name='A deliberately very long user-edited automatic bookmark name',user_modified_at=? WHERE id=?",
      ["2026-08-30T12:00:00.000Z", firstAutomatic.id]
    );
    getDemoSqlite().run(
      "INSERT INTO demo_bookmarks (video_id,user_id,timestamp_seconds,origin,analysis_run_id,name,created_at,updated_at) VALUES (3,1,12,'manual',NULL,'Manual moment',?,?)",
      ["2026-08-30T12:00:00.000Z", "2026-08-30T12:00:00.000Z"]
    );

    const forced = await service.start({
      videoId: 3,
      userId: 1,
      profile: "balanced",
      categories: ["BUTTOCKS_EXPOSED", "FEMALE_BREAST_EXPOSED"],
      force: true,
    });
    const rows = getDemoSqlite()
      .query<
        {
          origin: string;
          analysis_run_id: number | null;
          user_modified_at: string | null;
        },
        []
      >(
        "SELECT origin,analysis_run_id,user_modified_at FROM demo_bookmarks WHERE video_id=3 ORDER BY id"
      )
      .all();

    expect(forced.run.resultBookmarkCount).toBe(8);
    expect(rows.filter((row) => row.origin === "manual")).toHaveLength(1);
    expect(rows.filter((row) => row.origin === "automatic")).toHaveLength(9);
    expect(
      rows.filter(
        (row) =>
          row.analysis_run_id === first.run.id && row.user_modified_at !== null
      )
    ).toHaveLength(1);
    expect(
      rows.filter((row) => row.analysis_run_id === forced.run.id)
    ).toHaveLength(8);
    expect((await service.get(first.run.id, 1)).isPublished).toBe(false);
    const oldEvents = getDemoSqlite()
      .query<{ payload_json: string }, [string, string]>(
        "SELECT payload_json FROM demo_resources WHERE kind=? AND id LIKE ?"
      )
      .all("content-analysis-event", `${first.run.id}:%`)
      .map(({ payload_json }) => JSON.parse(payload_json));
    expect(oldEvents).toHaveLength(8);
    expect(oldEvents.every((event) => event.isPublished === false)).toBe(true);
  });

  it("accepts fast without opening media or Python", async () => {
    const result = await service.start({
      videoId: 1,
      userId: 1,
      profile: "fast",
      categories: ["BUTTOCKS_EXPOSED"],
    });

    expect(result).toMatchObject({
      reused: false,
      run: { profile: "fast", status: "completed", sampledFrames: 75 },
    });
  });
});
