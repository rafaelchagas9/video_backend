import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "fs";
import { isDemoRequestAllowed } from "@/utils/demo-mode-policy";
import { DEMO_ROUTE_SCENARIOS } from "./helpers/demo-route-manifest";

process.env.NODE_ENV = "test";
process.env.POSTGRES_USER ||= "demo-route-test";
process.env.POSTGRES_PASSWORD ||= "demo-route-test";
process.env.SESSION_SECRET ||=
  "demo-route-test-session-secret-at-least-32-characters";
process.env.POSTHOG_API_KEY = "";
process.env.POSTHOG_CAPTURE_REQUEST_METRICS = "false";

const databasePath = `/tmp/conversor-video-demo-route-coverage-${process.pid}.sqlite`;
const productionCastRoot = `/tmp/conversor-video-demo-route-cast-${process.pid}`;
const productionCastSession = `${productionCastRoot}/${"c".repeat(64)}`;

const PRIMARY_METHODS = ["get", "post", "put", "patch", "delete"] as const;
const POLICY_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
type ServerModule = typeof import("@/server");
type AppInstance = Awaited<ReturnType<ServerModule["buildServer"]>>;

function concretePath(path: string, entityType = "creator"): string {
  return path
    .replace("{entityType}", entityType)
    .replace("{sessionId}", "a".repeat(64))
    .replace("{token}", "b".repeat(64))
    .replace("{asset}", "index.m3u8")
    .replaceAll(/\{[^}]+\}/g, "1");
}

function fastifyPath(path: string): string {
  return path.replaceAll(/\{([^}]+)\}/g, ":$1");
}

describe("demo mode runtime route coverage", () => {
  let app: AppInstance;
  let runtimeOperationKeys: string[];
  let originalConfig: {
    demoMode: boolean;
    demoResetMode: "on-start" | "manual";
    castTranscodeDir: string;
  };

  beforeAll(async () => {
    const { env } = await import("@/config/env");
    originalConfig = {
      demoMode: env.DEMO_MODE,
      demoResetMode: env.DEMO_RESET_MODE,
      castTranscodeDir: env.CAST_TRANSCODE_DIR,
    };
    env.DEMO_MODE = true;
    env.DEMO_RESET_MODE = "manual";
    env.CAST_TRANSCODE_DIR = productionCastRoot;
    rmSync(productionCastRoot, { recursive: true, force: true });
    mkdirSync(productionCastSession, { recursive: true });
    writeFileSync(`${productionCastSession}/sentinel.txt`, "private");
    const old = new Date(0);
    utimesSync(productionCastSession, old, old);

    const { importDemoJsonFile, setDemoDatabasePathForTests } =
      await import("@/database/demo");
    setDemoDatabasePathForTests(databasePath);
    for (const path of [
      databasePath,
      `${databasePath}-shm`,
      `${databasePath}-wal`,
    ]) {
      rmSync(path, { force: true });
    }

    importDemoJsonFile(undefined, { reset: true });

    const { buildServer } = await import("@/server");
    app = await buildServer();
    await app.ready();

    const document = app.swagger();
    runtimeOperationKeys = Object.entries(document.paths ?? {})
      .flatMap(([path, pathItem]) =>
        PRIMARY_METHODS.filter((method) => Boolean(pathItem?.[method])).map(
          (method) => `${method.toUpperCase()} ${path}`
        )
      )
      .sort();
  });

  afterAll(async () => {
    await app.close();
    const { setDemoDatabasePathForTests } = await import("@/database/demo");
    setDemoDatabasePathForTests(null);
    for (const path of [
      databasePath,
      `${databasePath}-shm`,
      `${databasePath}-wal`,
    ]) {
      rmSync(path, { force: true });
    }

    const { env } = await import("@/config/env");
    env.DEMO_MODE = originalConfig.demoMode;
    env.DEMO_RESET_MODE = originalConfig.demoResetMode;
    env.CAST_TRANSCODE_DIR = originalConfig.castTranscodeDir;
    rmSync(productionCastRoot, { recursive: true, force: true });
  });

  it("does not scan or mutate the configured production Cast workspace", () => {
    expect(existsSync(productionCastSession)).toBe(true);
    expect(existsSync(`${productionCastSession}/sentinel.txt`)).toBe(true);
  });

  it("requires an explicit manifest record for all 275 primary operations", () => {
    const manifestKeys = DEMO_ROUTE_SCENARIOS.map(
      (scenario) => scenario.operationKey
    );
    const duplicateManifestKeys = manifestKeys.filter(
      (key, index) => manifestKeys.indexOf(key) !== index
    );
    const runtimeKeys = new Set(runtimeOperationKeys);
    const reviewedKeys = new Set(manifestKeys);

    expect(duplicateManifestKeys).toEqual([]);
    expect(runtimeOperationKeys).toHaveLength(275);
    expect(manifestKeys).toHaveLength(275);
    expect({
      missingFromRuntime: manifestKeys.filter((key) => !runtimeKeys.has(key)),
      missingFromManifest: runtimeOperationKeys.filter(
        (key) => !reviewedKeys.has(key)
      ),
    }).toEqual({
      missingFromRuntime: [],
      missingFromManifest: [],
    });
  });

  it("keeps the manifest classification aligned with the fail-closed policy", () => {
    const supportCounts = {
      allowed: 0,
      blocked: 0,
      conditional: 0,
    };

    for (const scenario of DEMO_ROUTE_SCENARIOS) {
      supportCounts[scenario.support] += 1;

      expect(
        isDemoRequestAllowed(scenario.method, concretePath(scenario.path))
      ).toBe(scenario.support === "allowed");
    }

    expect(supportCounts).toEqual({
      allowed: 275,
      blocked: 0,
      conditional: 0,
    });
    expect(
      DEMO_ROUTE_SCENARIOS.filter(
        (scenario) => scenario.verification === "http-contract"
      )
    ).toHaveLength(166);
  });

  it("allows only reviewed methods across every concrete manifest path", () => {
    const reviewedOperations = new Set(
      DEMO_ROUTE_SCENARIOS.filter(
        (scenario) => scenario.support === "allowed"
      ).map((scenario) => `${scenario.method} ${concretePath(scenario.path)}`)
    );
    const concretePaths = new Set(
      DEMO_ROUTE_SCENARIOS.map((scenario) => concretePath(scenario.path))
    );

    for (const path of concretePaths) {
      for (const method of POLICY_METHODS) {
        expect(isDemoRequestAllowed(method, path), `${method} ${path}`).toBe(
          reviewedOperations.has(`${method} ${path}`)
        );
      }
    }
  });

  it("registers and classifies all 114 generated HEAD counterparts", () => {
    const getScenarios = DEMO_ROUTE_SCENARIOS.filter(
      (scenario) => scenario.method === "GET"
    );
    expect(getScenarios).toHaveLength(114);

    for (const scenario of getScenarios) {
      expect(
        app.hasRoute({ method: "HEAD", url: fastifyPath(scenario.path) })
      ).toBe(true);

      if (scenario.support !== "conditional") {
        expect(isDemoRequestAllowed("HEAD", concretePath(scenario.path))).toBe(
          scenario.support === "allowed"
        );
      }
    }
  });

  it("covers WebSocket, OPTIONS, docs, and health outside primary API operations", async () => {
    expect(
      app.hasRoute({ method: "GET", url: "/api/multiplayer-remote/ws" })
    ).toBe(true);
    expect(isDemoRequestAllowed("GET", "/api/multiplayer-remote/ws")).toBe(
      true
    );

    expect(
      app.findRoute({ method: "OPTIONS", url: "/api/anything" })
    ).toBeDefined();
    expect(isDemoRequestAllowed("OPTIONS", "/api/anything")).toBe(true);

    for (const url of [
      "/docs",
      "/docs/",
      "/docs/json",
      "/docs/yaml",
      "/docs/static/index.html",
    ]) {
      expect(app.findRoute({ method: "GET", url })).toBeDefined();
      expect(isDemoRequestAllowed("GET", url)).toBe(true);
      expect(isDemoRequestAllowed("HEAD", url)).toBe(true);
    }

    const auditedHead = await app.inject({
      method: "HEAD",
      url: "/api/directories",
    });
    expect(auditedHead.statusCode).toBe(200);
    expect(auditedHead.body).toBe("");

    const blockedHead = await app.inject({
      method: "HEAD",
      url: "/api/new-private-feature",
    });
    expect(blockedHead.statusCode).toBe(403);
    expect(blockedHead.body).toBe("");
    expect(Number(blockedHead.headers["content-length"])).toBeGreaterThan(0);

    // Run an allowed HEAD immediately afterward to catch double-reply/fallthrough
    // bugs in the generated Fastify HEAD handler.
    const health = await app.inject({ method: "HEAD", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(health.body).toBe("");
  });

  it("keeps unknown future operations fail-closed", () => {
    expect(isDemoRequestAllowed("GET", "/api/new-private-feature")).toBe(false);
    expect(isDemoRequestAllowed("HEAD", "/api/new-private-feature")).toBe(
      false
    );
    expect(isDemoRequestAllowed("POST", "/api/videos/new-action")).toBe(false);
  });

  it("preserves demo missing and membership-conflict HTTP contracts", async () => {
    const missingVideo = await app.inject({
      method: "GET",
      url: "/api/videos/999999",
    });
    expect(missingVideo.statusCode).toBe(404);

    const missingCollection = await app.inject({
      method: "GET",
      url: "/api/video-collections/999999",
    });
    expect(missingCollection.statusCode).toBe(404);

    const collection = await app.inject({
      method: "POST",
      url: "/api/video-collections",
      payload: { title: "Demo conflict contract", kind: "movie_series" },
    });
    expect(collection.statusCode, collection.body).toBe(201);
    const collectionId = collection.json().data.id as number;
    const missingEntryVideo = await app.inject({
      method: "POST",
      url: `/api/video-collections/${collectionId}/entries`,
      payload: { video_id: 999999, entry_kind: "episode" },
    });
    expect(missingEntryVideo.statusCode).toBe(404);

    const missingEntries = await app.inject({
      method: "GET",
      url: "/api/video-collections/999999/entries",
    });
    expect(missingEntries.statusCode).toBe(404);

    const { getDemoSqlite } = await import("@/database/demo");
    const unassignedVideo = getDemoSqlite()
      .query<{ id: number }, []>(
        `SELECT v.id
         FROM demo_videos v
         LEFT JOIN demo_collection_entries e ON e.video_id = v.id
         WHERE e.video_id IS NULL
         ORDER BY v.id
         LIMIT 1`
      )
      .get();
    expect(unassignedVideo).toBeDefined();

    const addEntry = () =>
      app.inject({
        method: "POST",
        url: `/api/video-collections/${collectionId}/entries`,
        payload: {
          video_id: unassignedVideo!.id,
          entry_kind: "episode",
        },
      });
    const added = await addEntry();
    expect(added.statusCode, added.body).toBe(201);
    const duplicateEntry = await addEntry();
    expect(duplicateEntry.statusCode).toBe(409);

    const playlist = await app.inject({
      method: "POST",
      url: "/api/playlists",
      payload: { name: "Demo duplicate contract" },
    });
    expect(playlist.statusCode, playlist.body).toBe(201);
    const playlistId = playlist.json().data.id as number;
    const addPlaylistVideo = () =>
      app.inject({
        method: "POST",
        url: `/api/playlists/${playlistId}/videos`,
        payload: { video_id: unassignedVideo!.id },
      });
    const playlistAdded = await addPlaylistVideo();
    expect(playlistAdded.statusCode, playlistAdded.body).toBe(201);
    const duplicatePlaylistVideo = await addPlaylistVideo();
    expect(duplicatePlaylistVideo.statusCode).toBe(409);
  });

  it("serves conversion lifecycle and legacy aliases from demo SQLite", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/videos/1/conversions",
      payload: { preset: "1080p_av1" },
    });
    expect(create.statusCode).toBe(201);
    const job = create.json().data;
    expect(job).toMatchObject({ video_id: 1, status: "pending" });

    for (const request of [
      { method: "GET" as const, url: `/api/conversions/${job.id}` },
      { method: "GET" as const, url: "/api/videos/1/conversions" },
      { method: "GET" as const, url: "/api/conversions/queue" },
      { method: "GET" as const, url: "/api/videos/convert/queue" },
      { method: "GET" as const, url: "/api/conversions/active" },
      { method: "GET" as const, url: "/api/conversions/queue/status" },
      { method: "GET" as const, url: "/api/conversions/status" },
      { method: "GET" as const, url: "/api/conversion/status" },
      { method: "GET" as const, url: "/api/conversions/presets" },
      { method: "GET" as const, url: "/api/presets" },
    ]) {
      const response = await app.inject(request);
      expect(response.statusCode, `${request.method} ${request.url}`).toBe(200);
    }

    const cancelled = await app.inject({
      method: "PATCH",
      url: `/api/conversions/${job.id}`,
      payload: { status: "cancelled" },
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().data.status).toBe("cancelled");

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/conversions/${job.id}`,
    });
    expect(deleted.statusCode).toBe(200);

    const legacyCreate = await app.inject({
      method: "POST",
      url: "/api/videos/2/convert",
      payload: { preset: "1080p_av1" },
    });
    expect(legacyCreate.statusCode).toBe(201);
    const legacyJob = legacyCreate.json().data;
    const legacyCancel = await app.inject({
      method: "POST",
      url: `/api/conversions/${legacyJob.id}/cancel`,
    });
    expect(legacyCancel.statusCode).toBe(200);

    for (const request of [
      {
        method: "POST" as const,
        url: "/api/conversions",
        payload: { videoIds: [3], preset: "1080p_av1" },
      },
      {
        method: "POST" as const,
        url: "/api/videos/convert/bulk",
        payload: { videoIds: [4], preset: "1080p_av1" },
      },
    ]) {
      const response = await app.inject(request);
      expect(response.statusCode, `${request.method} ${request.url}`).toBe(201);
    }

    const missingDownload = await app.inject({
      method: "GET",
      url: "/api/conversions/999999/download",
    });
    expect(missingDownload.statusCode).toBe(404);

    const clear = await app.inject({
      method: "POST",
      url: "/api/conversions/queue/clear",
    });
    expect(clear.statusCode).toBe(200);
    expect(clear.json().data.pendingCleared).toBe(2);
  });

  it("serves every canonical and legacy stats contract from demo SQLite", async () => {
    for (const url of [
      "/api/stats/storage",
      "/api/stats/storage/history",
      "/api/stats/library",
      "/api/stats/library/history",
      "/api/stats/content",
      "/api/stats/content/history",
      "/api/stats/usage",
      "/api/stats/usage/history",
    ]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, `GET ${url}`).toBe(200);
      expect(response.json().success).toBe(true);
    }

    for (const url of [
      "/api/stats/storage-snapshots",
      "/api/stats/library-snapshots",
      "/api/stats/content-snapshots",
      "/api/stats/usage-snapshots",
      "/api/stats/snapshots",
      "/api/stats/storage/snapshot",
      "/api/stats/library/snapshot",
      "/api/stats/content/snapshot",
      "/api/stats/usage/snapshot",
      "/api/stats/snapshot",
    ]) {
      const response = await app.inject({ method: "POST", url });
      expect(response.statusCode, `POST ${url}`).toBe(201);
      expect(response.json().success).toBe(true);
    }
  });

  it("persists settings and enrichment decisions in demo SQLite", async () => {
    const update = await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { settings: { max_suggestions: 25 } },
    });
    expect(update.statusCode).toBe(200);
    const settings = await app.inject({ method: "GET", url: "/api/settings" });
    expect(settings.statusCode).toBe(200);
    expect(
      settings
        .json()
        .data.find((item: { key: string }) => item.key === "max_suggestions")
        .value
    ).toBe(25);

    for (const entityType of ["creator", "studio", "scene", "tag"]) {
      const run = await app.inject({
        method: "POST",
        url: `/api/enrichment/${entityType}/1/run`,
        payload: { sources: ["theporndb"] },
      });
      expect(run.statusCode, `POST enrichment ${entityType}`).toBe(200);
      const runs = await app.inject({
        method: "GET",
        url: `/api/enrichment/${entityType}/1/runs`,
      });
      expect(runs.statusCode, `GET enrichment ${entityType}`).toBe(200);
      expect(runs.json().data).toHaveLength(1);
    }

    const suggestions = await app.inject({
      method: "GET",
      url: "/api/enrichment/suggestions?status=pending",
    });
    expect(suggestions.statusCode).toBe(200);
    const pending = suggestions.json().data as Array<{ id: number }>;
    expect(pending.length).toBeGreaterThanOrEqual(2);

    const accepted = await app.inject({
      method: "POST",
      url: `/api/enrichment/suggestions/${pending[0]!.id}/accept`,
    });
    const rejected = await app.inject({
      method: "POST",
      url: `/api/enrichment/suggestions/${pending[1]!.id}/reject`,
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().data.status).toBe("accepted");
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json().data.status).toBe("rejected");
  });

  it("simulates the complete edit lifecycle without FFmpeg or Redis", async () => {
    const metadata = await app.inject({
      method: "GET",
      url: "/api/videos/1/editing-metadata",
    });
    expect(metadata.statusCode).toBe(200);
    expect(metadata.json().data.id).toBe(1);

    const create = await app.inject({
      method: "POST",
      url: "/api/videos/1/edits",
      payload: {
        output: {
          directory_id: 1,
          file_name: "demo-edit.mkv",
          format: "mkv",
          video_codec: "av1",
          audio_codec: "opus",
        },
        timeline: { segments: [{ start: 0, end: 10, speed: 1 }] },
      },
    });
    expect(create.statusCode).toBe(202);
    const jobId = create.json().data.job_id;

    const status = await app.inject({
      method: "GET",
      url: `/api/edits/jobs/${jobId}`,
    });
    expect(status.statusCode).toBe(200);
    expect(status.json().data).toMatchObject({
      status: "running",
      progress: 25,
    });

    const cancel = await app.inject({
      method: "POST",
      url: `/api/edits/jobs/${jobId}/cancel`,
    });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json().data.status).toBe("cancelled");
  });
});
