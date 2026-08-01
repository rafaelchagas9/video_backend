import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { rmSync } from "fs";

process.env.NODE_ENV = "test";
process.env.POSTGRES_USER ||= "demo-privacy-boundary-test";
process.env.POSTGRES_PASSWORD ||= "demo-privacy-boundary-test";
process.env.SESSION_SECRET ||=
  "demo-privacy-boundary-session-secret-at-least-32-characters";
process.env.POSTHOG_API_KEY = "";
process.env.POSTHOG_CAPTURE_REQUEST_METRICS = "false";

const databasePath = `/tmp/conversor-video-demo-privacy-boundary-${process.pid}.sqlite`;

describe("allowed demo route privacy boundaries", () => {
  let app: Awaited<ReturnType<typeof import("@/server").buildServer>>;
  let sqlite: import("bun:sqlite").Database;
  let originalDemoMode: boolean;
  let originalResetMode: "on-start" | "manual";

  beforeAll(async () => {
    const { env } = await import("@/config/env");
    originalDemoMode = env.DEMO_MODE;
    originalResetMode = env.DEMO_RESET_MODE;
    env.DEMO_MODE = true;
    env.DEMO_RESET_MODE = "manual";

    const demo = await import("@/database/demo");
    demo.setDemoDatabasePathForTests(databasePath);
    for (const path of [
      databasePath,
      `${databasePath}-shm`,
      `${databasePath}-wal`,
    ]) {
      rmSync(path, { force: true });
    }
    demo.importDemoJsonFile(undefined, { reset: true });
    sqlite = demo.getDemoSqlite();

    const { buildServer } = await import("@/server");
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    const demo = await import("@/database/demo");
    demo.closeDemoDatabase();
    demo.setDemoDatabasePathForTests(null);
    for (const path of [
      databasePath,
      `${databasePath}-shm`,
      `${databasePath}-wal`,
    ]) {
      rmSync(path, { force: true });
    }
    const { env } = await import("@/config/env");
    env.DEMO_MODE = originalDemoMode;
    env.DEMO_RESET_MODE = originalResetMode;
  });

  it("rejects a poisoned video stream path before reading outside demo assets", async () => {
    const original = sqlite
      .query<
        { file_path: string },
        []
      >("SELECT file_path FROM demo_videos WHERE id=1")
      .get()!;
    sqlite.run("UPDATE demo_videos SET file_path=? WHERE id=1", [
      "/etc/passwd",
    ]);

    const response = await app.inject({
      method: "GET",
      url: "/api/videos/1/stream",
      headers: { range: "bytes=0-16" },
    });
    expect(response.statusCode).toBe(500);

    sqlite.run("UPDATE demo_videos SET file_path=? WHERE id=1", [
      original.file_path,
    ]);
    const safe = await app.inject({
      method: "GET",
      url: "/api/videos/1/stream",
      headers: { range: "bytes=0-16" },
    });
    expect(safe.statusCode, safe.body).toBe(206);
  });

  it("does not stream a file marked unavailable in demo SQLite", async () => {
    sqlite.run("UPDATE demo_videos SET is_available=0 WHERE id=1");

    const response = await app.inject({
      method: "GET",
      url: "/api/videos/1/stream",
      headers: { range: "bytes=0-16" },
    });
    expect(response.statusCode, response.body).toBe(410);

    sqlite.run("UPDATE demo_videos SET is_available=1 WHERE id=1");
  });

  it("never falls back to public profile images outside demo assets", async () => {
    sqlite.run(
      "UPDATE demo_creators SET profile_picture_path=NULL, main_picture_path=NULL, face_thumbnail_path=NULL WHERE id=1"
    );
    sqlite.run("UPDATE demo_studios SET profile_picture_path=NULL WHERE id=1");

    const creator = await app.inject({
      method: "GET",
      url: "/api/creators/1/picture",
    });
    expect(creator.statusCode, creator.body).toBe(404);

    const studio = await app.inject({
      method: "GET",
      url: "/api/studios/1/picture",
    });
    expect(studio.statusCode, studio.body).toBe(404);
  });

  it("autogenerates a missing storyboard only inside demo runtime assets", async () => {
    sqlite.run("DELETE FROM demo_storyboards WHERE video_id=1");

    const queued = await app.inject({
      method: "GET",
      url: "/api/videos/1/thumbnails.vtt?autogenerate=true",
    });
    expect(queued.statusCode, queued.body).toBe(404);

    const generated = sqlite
      .query<
        { sprite_path: string; vtt_path: string },
        []
      >("SELECT sprite_path,vtt_path FROM demo_storyboards WHERE video_id=1")
      .get();
    expect(generated).toBeDefined();
    const { isDemoAssetPath } = await import("@/database/demo");
    expect(isDemoAssetPath(generated!.sprite_path)).toBe(true);
    expect(isDemoAssetPath(generated!.vtt_path)).toBe(true);

    const served = await app.inject({
      method: "GET",
      url: "/api/videos/1/thumbnails.vtt",
    });
    expect(served.statusCode, served.body).toBe(200);
    expect(served.headers["content-type"]).toContain("text/vtt");
  });
});
