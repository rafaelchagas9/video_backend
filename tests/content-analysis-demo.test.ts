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
  getDemoSqlite()
    .query(
      "INSERT INTO demo_videos (id,source_video_id,file_path,file_name,directory_id,file_size_bytes,duration_seconds,is_available,indexed_at,created_at,updated_at) VALUES (1,1,?,?,?,?,1,1,?,?,?)"
    )
    .run(
      "demo_mode/video/synthetic.webm",
      "synthetic.webm",
      1,
      100,
      timestamp,
      timestamp,
      timestamp
    );
});

afterEach(removeDatabaseFiles);
afterAll(() => {
  setDemoDatabasePathForTests(null);
  env.DEMO_MODE = originalDemoMode;
});

describe("demo content analysis", () => {
  it("persists a deterministic zero-result run without opening media or Python", async () => {
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
        modelRevision: "demo-no-inference",
      },
    });
    expect(reused).toMatchObject({ reused: true, run: { id: first.run.id } });
    expect((await service.get(first.run.id, 1)).id).toBe(first.run.id);
    expect((await service.cancel(first.run.id, 1)).status).toBe("completed");
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
      run: { profile: "fast", status: "completed", sampledFrames: 0 },
    });
  });
});
