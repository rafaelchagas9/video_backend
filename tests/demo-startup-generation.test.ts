import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";

process.env.NODE_ENV = "test";
process.env.POSTGRES_USER ||= "demo-startup-test";
process.env.POSTGRES_PASSWORD ||= "demo-startup-test";
process.env.SESSION_SECRET ||=
  "demo-startup-session-secret-at-least-32-characters";

const databasePath = `/tmp/conversor-video-demo-startup-${process.pid}.sqlite`;
const baselinePath = `${databasePath}.baseline`;
const assetsRoot = `/tmp/conversor-video-demo-assets-${process.pid}`;
let demo: typeof import("@/database/demo");
let env: typeof import("@/config/env").env;
let originalAssetsDir: string;

function removeLiveDatabase(): void {
  demo?.closeDemoDatabase();
  for (const path of [
    databasePath,
    `${databasePath}-shm`,
    `${databasePath}-wal`,
  ]) {
    rmSync(path, { force: true });
  }
}

function removeAllTestState(): void {
  removeLiveDatabase();
  for (const path of [
    baselinePath,
    `${baselinePath}-shm`,
    `${baselinePath}-wal`,
  ]) {
    rmSync(path, { force: true });
  }
  rmSync(assetsRoot, { recursive: true, force: true });
}

describe("demo startup and generation contracts", () => {
  beforeAll(async () => {
    ({ env } = await import("@/config/env"));
    originalAssetsDir = env.DEMO_ASSETS_DIR;
    env.DEMO_ASSETS_DIR = assetsRoot;

    demo = await import("@/database/demo");
    removeAllTestState();
    demo.setDemoDatabasePathForTests(databasePath);
    demo.initializeDemoDatabase();
    const timestamp = "2026-08-01T00:00:00.000Z";
    demo.getDemoSqlite().run(
      `INSERT INTO demo_videos
       (id, source_video_id, file_path, file_name, directory_id,
        file_size_bytes, file_hash, duration_seconds, width, height, codec,
        bitrate, fps, audio_codec, title, description, themes, is_available,
        last_verified_at, indexed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        1,
        null,
        join(assetsRoot, "video", "baseline.mp4"),
        "baseline.mp4",
        1,
        1,
        null,
        1,
        1,
        1,
        "h264",
        null,
        null,
        "aac",
        "Immutable baseline title",
        null,
        null,
        1,
        timestamp,
        timestamp,
        timestamp,
        timestamp,
      ]
    );
    demo.createDemoBaselineSnapshot();
    demo.closeDemoDatabase();
  });

  beforeEach(() => {
    removeLiveDatabase();
    mkdirSync(join(assetsRoot, "runtime"), { recursive: true });
    writeFileSync(join(assetsRoot, "runtime", "transient.txt"), "runtime");
    writeFileSync(join(assetsRoot, "seeded.txt"), "seeded");
  });

  afterAll(() => {
    demo.setDemoDatabasePathForTests(null);
    env.DEMO_ASSETS_DIR = originalAssetsDir;
    removeAllTestState();
  });

  it("restores a missing live database before validating its seed on start", () => {
    expect(existsSync(baselinePath)).toBe(true);

    demo.prepareDemoDatabaseForStartup("on-start");

    expect(demo.hasDemoSeed()).toBe(true);
    expect(
      demo
        .getDemoSqlite()
        .query<
          { title: string },
          []
        >("SELECT title FROM demo_videos WHERE id = 1")
        .get()?.title
    ).toBe("Immutable baseline title");
    expect(existsSync(join(assetsRoot, "runtime", "transient.txt"))).toBe(
      false
    );
    expect(existsSync(join(assetsRoot, "seeded.txt"))).toBe(true);
  });

  it("does not silently restore an empty database in manual mode", () => {
    expect(() => demo.prepareDemoDatabaseForStartup("manual")).toThrow(
      "Demo SQLite database has no seed"
    );
  });

  it("uses DEMO_ASSETS_DIR for legacy migration defaults", () => {
    const expectedJson = join(assetsRoot, "demo_mode.json");
    const expectedArtwork = join(assetsRoot, "artwork", "manifest.json");

    expect(() => demo.importDemoJsonFile()).toThrow(expectedJson);
    expect(() => demo.importDemoArtworkManifestFile()).toThrow(expectedArtwork);
  });

  it("keeps fresh generation independent from JSON and refreshes its baseline", () => {
    const downloader = readFileSync(
      resolve(process.cwd(), "scripts/download-demo-media.ts"),
      "utf8"
    );
    const artwork = readFileSync(
      resolve(process.cwd(), "scripts/generate-demo-artwork.ts"),
      "utf8"
    );

    expect(downloader).toContain("process.env.DEMO_ASSETS_DIR");
    expect(downloader).toContain("hasDemoSeed()");
    expect(downloader).toContain("createDemoBaselineSnapshot()");
    expect(downloader).not.toContain("importDemoJsonFile");
    expect(artwork).toContain("process.env.DEMO_ASSETS_DIR");
    expect(artwork).toContain(
      "createBaselineSnapshot: createDemoBaselineSnapshot"
    );
    expect(artwork).toContain(".artwork-staging-");
    expect(artwork).toContain("commitStagedDemoArtwork");
    expect(artwork).not.toContain("rm(OUTPUT_ROOT");
  });
});
