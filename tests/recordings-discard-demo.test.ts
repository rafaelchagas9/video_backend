import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { createDemoFixtureFiles } from "./helpers/demo-fixtures";

process.env.NODE_ENV = "test";
process.env.POSTGRES_USER ||= "recordings-discard-demo-test";
process.env.POSTGRES_PASSWORD ||= "recordings-discard-demo-test";
process.env.SESSION_SECRET ||= "recordings-discard-demo-session-secret-at-least-32-characters";
process.env.POSTHOG_API_KEY = "";
process.env.POSTHOG_CAPTURE_REQUEST_METRICS = "false";

// Nothing listens here, so the overview sees GoondVR as unreachable.
process.env.GOONDVR_API_URL = "http://127.0.0.1:9/api/v1";

describe("deleting a recording from its review in demo mode", () => {
  const app = Fastify({ logger: false });
  const root = mkdtempSync(join(tmpdir(), "conversor-recordings-discard-"));
  let originalDemoMode: boolean;
  let originalAssetsDir: string;
  let sqlite: import("bun:sqlite").Database;
  let service: typeof import("@/modules/recordings/recordings.service").recordingsService;

  const recordingIds = async () =>
    (await app.inject({ method: "GET", url: "/api/recordings" }))
      .json()
      .data.recordings.map((entry: { video: { id: number } }) => entry.video.id) as number[];
  const videoExists = (id: number) => Boolean(sqlite.query("SELECT 1 FROM demo_videos WHERE id = ?").get(id));
  const review = (videoId: number, status: string, clips: Record<string, unknown>[]) =>
    // The demo keeps reviews in memory; analysing needs a visual index the fixtures lack.
    (service as unknown as { save(row: unknown): Promise<void> }).save({
      videoId,
      status,
      clips,
      curve: [],
      promptsRevision: "",
      deleteOriginal: false,
      error: null,
      analyzedAt: new Date(),
    });

  beforeAll(async () => {
    const { env } = await import("@/config/env");
    originalDemoMode = env.DEMO_MODE;
    originalAssetsDir = env.DEMO_ASSETS_DIR;
    env.DEMO_MODE = true;
    env.DEMO_ASSETS_DIR = root;
    const fixtures = createDemoFixtureFiles(root);
    const demo = await import("@/database/demo");
    demo.setDemoDatabasePathForTests(join(root, "demo.sqlite"));
    demo.importDemoJsonFile(fixtures.seedPath, { reset: true });
    sqlite = demo.getDemoSqlite();
    // The demo lists only recordings of at least 15 minutes.
    sqlite.run("UPDATE demo_videos SET duration_seconds = 1800 WHERE id <= 5");

    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.setErrorHandler((error, _request, reply) => {
      const caught = error as { message?: string; statusCode?: number };
      return reply.status(caught.statusCode ?? 500).send({ success: false, error: { message: caught.message } });
    });
    ({ recordingsService: service } = await import("@/modules/recordings/recordings.service"));
    const { recordingsRoutes } = await import("@/modules/recordings/recordings.routes");
    await app.register(recordingsRoutes, { prefix: "/api/recordings" });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    const { setDemoDatabasePathForTests } = await import("@/database/demo");
    setDemoDatabasePathForTests(null);
    rmSync(root, { recursive: true, force: true });
    const { env } = await import("@/config/env");
    env.DEMO_MODE = originalDemoMode;
    env.DEMO_ASSETS_DIR = originalAssetsDir;
  });

  it("deletes a recording that covers a playlist and a collection", async () => {
    const cover = sqlite
      .query<{ id: number }, []>(
        `SELECT artwork_source_video_id AS id FROM demo_playlists
         WHERE artwork_source_video_id IN (SELECT artwork_source_video_id FROM demo_collections)
           AND artwork_source_video_id <= 5`
      )
      .get()!.id;
    expect(await recordingIds()).toContain(cover);

    const response = await app.inject({ method: "DELETE", url: `/api/recordings/${cover}` });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data).toEqual({ video_id: cover });
    expect(videoExists(cover)).toBe(false);
    expect(await recordingIds()).not.toContain(cover);
    for (const table of ["demo_playlists", "demo_collections"])
      expect(sqlite.query(`SELECT count(*) AS count FROM ${table} WHERE artwork_source_video_id = ?`).get(cover)).toEqual({ count: 0 });
  });

  it("keeps the clips already made from the recording", async () => {
    await review(4, "proposed", [
      { id: "c1", start_seconds: 10, end_seconds: 40, peak_seconds: 20, score: 1, label: "", keep: true, job_id: 1, output_video_id: 6 },
      { id: "c2", start_seconds: 60, end_seconds: 90, peak_seconds: 70, score: 1, label: "", keep: false },
    ]);
    const response = await app.inject({ method: "DELETE", url: "/api/recordings/4" });
    expect(response.statusCode, response.body).toBe(200);
    expect(videoExists(4)).toBe(false);
    expect(videoExists(6)).toBe(true);
    expect(await recordingIds()).not.toContain(4);
    // The review goes with it.
    expect((await app.inject({ method: "GET", url: "/api/recordings/4" })).json().data).toMatchObject({ video: null, status: "pending", clips: [] });
  });

  it("refuses while clips are rendering, and 404s once gone", async () => {
    await review(2, "rendering", []);
    const rendering = await app.inject({ method: "DELETE", url: "/api/recordings/2" });
    expect(rendering.statusCode).toBe(400);
    expect(videoExists(2)).toBe(true);

    const gone = await app.inject({ method: "DELETE", url: "/api/recordings/4" });
    expect(gone.statusCode).toBe(404);
  });
});
