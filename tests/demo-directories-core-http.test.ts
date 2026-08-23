import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { rmSync } from "fs";
import { resolve, sep } from "path";
import Fastify from "fastify";
import swagger from "@fastify/swagger";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";

process.env.NODE_ENV = "test";
process.env.POSTGRES_USER ||= "demo-core-http-test";
process.env.POSTGRES_PASSWORD ||= "demo-core-http-test";
process.env.SESSION_SECRET ||=
  "demo-core-http-session-secret-at-least-32-characters";
process.env.POSTHOG_API_KEY = "";
process.env.POSTHOG_CAPTURE_REQUEST_METRICS = "false";

const databasePath = `/tmp/conversor-video-demo-core-http-${process.pid}.sqlite`;

describe("demo directories and core video HTTP contracts", () => {
  const app = Fastify({ logger: false });
  let originalDemoMode: boolean;
  let sqlite: import("bun:sqlite").Database;

  beforeAll(async () => {
    const { env } = await import("@/config/env");
    originalDemoMode = env.DEMO_MODE;
    env.DEMO_MODE = true;
    const demo = await import("@/database/demo");
    demo.setDemoDatabasePathForTests(databasePath);
    for (const path of [
      databasePath,
      `${databasePath}-shm`,
      `${databasePath}-wal`,
    ])
      rmSync(path, { force: true });
    demo.importDemoJsonFile(undefined, { reset: true });
    sqlite = demo.getDemoSqlite();

    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(swagger, {
      openapi: { info: { title: "Directory contract", version: "1" } },
      transform: jsonSchemaTransform,
    });
    app.setErrorHandler((error, _request, reply) => {
      const caught = error as { message?: string; statusCode?: number };
      const statusCode = caught.statusCode ?? 500;
      return reply.status(statusCode).send({
        success: false,
        error: {
          message: caught.message ?? "Request failed",
          statusCode,
        },
      });
    });
    const { directoriesRoutes } =
      await import("@/modules/directories/directories.routes");
    const { videosRoutes } = await import("@/modules/videos/videos.routes");
    await app.register(directoriesRoutes, { prefix: "/api/directories" });
    await app.register(videosRoutes, { prefix: "/api/videos" });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    const { setDemoDatabasePathForTests } = await import("@/database/demo");
    setDemoDatabasePathForTests(null);
    for (const path of [
      databasePath,
      `${databasePath}-shm`,
      `${databasePath}-wal`,
    ])
      rmSync(path, { force: true });
    const { env } = await import("@/config/env");
    env.DEMO_MODE = originalDemoMode;
  });

  it("serves the complete virtual directory lifecycle without the watcher", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/directories",
      payload: {
        path: "demo_mode/http-fixture",
        auto_scan: false,
        scan_interval_minutes: 15,
      },
    });
    expect(create.statusCode, create.body).toBe(201);
    const id = create.json().data.id as number;

    for (const url of [
      "/api/directories",
      `/api/directories/${id}`,
      `/api/directories/${id}/stats`,
    ]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, `GET ${url}: ${response.body}`).toBe(200);
    }
    const patch = await app.inject({
      method: "PATCH",
      url: `/api/directories/${id}`,
      payload: { is_active: false, scan_interval_minutes: 45 },
    });
    expect(patch.statusCode, patch.body).toBe(200);
    expect(patch.json().data).toMatchObject({
      is_active: false,
      scan_interval_minutes: 45,
    });

    const scan = await app.inject({
      method: "POST",
      url: `/api/directories/${id}/scan`,
    });
    expect(scan.statusCode, scan.body).toBe(202);
    const run = scan.json().data;
    expect(run).toMatchObject({ directory_id: id, status: "running" });
    expect(scan.headers.location).toBe(
      `/api/directories/${id}/scans/${run.id}`
    );

    const detail = await app.inject({
      method: "GET",
      url: scan.headers.location,
    });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json().data).toMatchObject({
      id: run.id,
      directory_id: id,
      status: "completed",
      files_added: 0,
      files_updated: 0,
      files_removed: 0,
      error_count: 0,
    });

    const history = await app.inject({
      method: "GET",
      url: `/api/directories/${id}/scans?page=1&limit=1`,
    });
    expect(history.statusCode, history.body).toBe(200);
    expect(history.json().data).toHaveLength(1);
    expect(history.json().pagination).toMatchObject({ page: 1, limit: 1 });

    const scheduler = await app.inject({
      method: "GET",
      url: "/api/directories/scheduler/status",
    });
    expect(scheduler.statusCode, scheduler.body).toBe(200);
    expect(scheduler.json().data).toEqual({
      is_running: false,
      scheduled_directories: 0,
      schedules: [],
      system_tasks: [],
    });

    const second = await app.inject({
      method: "POST",
      url: "/api/directories",
      payload: { path: "demo_mode/other", auto_scan: false },
    });
    const crossDirectory = await app.inject({
      method: "GET",
      url: `/api/directories/${second.json().data.id}/scans/${run.id}`,
    });
    expect(crossDirectory.statusCode, crossDirectory.body).toBe(404);
    const remove = await app.inject({
      method: "DELETE",
      url: `/api/directories/${id}`,
    });
    expect(remove.statusCode, remove.body).toBe(200);
  });

  it("bounds and sanitizes stored scan errors", async () => {
    const errors = [
      "/home/user/private/movie.mkv: decoder failed",
      "second",
      "third",
      "fourth",
      "fifth",
      "sixth",
    ];
    sqlite.run(
      "INSERT INTO demo_resources (kind,id,payload_json,created_at,updated_at) VALUES (?,?,?,?,?)",
      [
        "directory_scan",
        "900",
        JSON.stringify({
          id: 900,
          directory_id: 1,
          status: "completed",
          files_found: 1,
          files_added: 0,
          files_updated: 0,
          files_removed: 0,
          errors,
          started_at: "2026-01-03T00:00:00.000Z",
          completed_at: "2026-01-03T00:00:01.000Z",
        }),
        "2026-01-03T00:00:00.000Z",
        "2026-01-03T00:00:01.000Z",
      ]
    );
    const response = await app.inject({
      method: "GET",
      url: "/api/directories/1/scans/900",
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data.error_count).toBe(6);
    expect(response.json().data.error_summaries).toHaveLength(5);
    expect(response.body).not.toContain("/home/user/private/movie.mkv");
    expect(response.body).not.toContain("movie.mkv");
  });

  it("documents scan failures and the accepted-run Location header", () => {
    const paths = app.swagger().paths as Record<
      string,
      Record<
        string,
        {
          responses?: Record<
            string,
            { headers?: Record<string, { description?: string }> }
          >;
        }
      >
    >;

    expect(paths["/api/directories/{id}/scans"]?.get?.responses).toEqual(
      expect.objectContaining({
        "200": expect.anything(),
        "400": expect.anything(),
        "401": expect.anything(),
        "404": expect.anything(),
        "500": expect.anything(),
      })
    );
    expect(
      paths["/api/directories/{id}/scans/{scanId}"]?.get?.responses
    ).toEqual(
      expect.objectContaining({
        "200": expect.anything(),
        "400": expect.anything(),
        "401": expect.anything(),
        "404": expect.anything(),
        "500": expect.anything(),
      })
    );
    expect(
      paths["/api/directories/scheduler/status"]?.get?.responses
    ).toEqual(
      expect.objectContaining({
        "200": expect.anything(),
        "401": expect.anything(),
        "500": expect.anything(),
      })
    );

    const startResponses =
      paths["/api/directories/{id}/scan"]?.post?.responses;
    expect(startResponses).toEqual(
      expect.objectContaining({
        "202": expect.anything(),
        "400": expect.anything(),
        "401": expect.anything(),
        "404": expect.anything(),
        "409": expect.anything(),
        "500": expect.anything(),
      })
    );
    expect(startResponses?.["202"]?.headers?.Location?.description).toContain(
      "accepted scan-run resource"
    );
  });

  it("serves video metadata, verification, duplicates, and unavailable contracts", async () => {
    const { env } = await import("@/config/env");
    const { resolveDemoAssetPath } = await import("@/database/demo");
    const assetRoot = resolve(process.cwd(), env.DEMO_ASSETS_DIR);
    const demoPaths = sqlite
      .query<{ file_path: string }, []>("SELECT file_path FROM demo_videos")
      .all();
    for (const row of demoPaths) {
      const resolved = resolveDemoAssetPath(row.file_path);
      expect(
        resolved === assetRoot || resolved.startsWith(`${assetRoot}${sep}`)
      ).toBe(true);
    }

    const patch = await app.inject({
      method: "PATCH",
      url: "/api/videos/1",
      payload: { title: "HTTP-updated demo title" },
    });
    expect(patch.statusCode, patch.body).toBe(200);
    expect(patch.json().data.title).toBe("HTTP-updated demo title");

    const verify = await app.inject({
      method: "POST",
      url: "/api/videos/1/verify",
    });
    expect(verify.statusCode, verify.body).toBe(200);

    const setMetadata = await app.inject({
      method: "POST",
      url: "/api/videos/1/metadata",
      payload: { key: "http-audit", value: "sqlite-only" },
    });
    expect(setMetadata.statusCode, setMetadata.body).toBe(201);
    const metadata = await app.inject({
      method: "GET",
      url: "/api/videos/1/metadata",
    });
    expect(metadata.statusCode, metadata.body).toBe(200);
    expect(metadata.json().data).toContainEqual({
      key: "http-audit",
      value: "sqlite-only",
    });
    const deleteMetadata = await app.inject({
      method: "DELETE",
      url: "/api/videos/1/metadata/http-audit",
    });
    expect(deleteMetadata.statusCode, deleteMetadata.body).toBe(200);

    const duplicates = await app.inject({
      method: "GET",
      url: "/api/videos/duplicates",
    });
    expect(duplicates.statusCode, duplicates.body).toBe(200);
    expect(Array.isArray(duplicates.json().data)).toBe(true);

    sqlite.run("UPDATE demo_videos SET is_available = 0 WHERE id = 129");
    const unavailable = await app.inject({
      method: "GET",
      url: "/api/videos/unavailable",
    });
    expect(unavailable.statusCode, unavailable.body).toBe(200);
    expect(
      unavailable.json().data.some((video: { id: number }) => video.id === 129)
    ).toBe(true);

    const cleanup = await app.inject({
      method: "POST",
      url: "/api/videos/unavailable/cleanup",
      payload: { ids: [129] },
    });
    expect(cleanup.statusCode, cleanup.body).toBe(200);
    expect(cleanup.json().deleted_ids).toEqual([129]);

    const verifyUnavailable = await app.inject({
      method: "POST",
      url: "/api/videos/unavailable/verify",
      payload: {},
    });
    expect(verifyUnavailable.statusCode, verifyUnavailable.body).toBe(200);
    expect(verifyUnavailable.json().checked).toBeGreaterThan(0);
  });

  it("serves bulk video mutations and exact relationship routes from SQLite", async () => {
    for (const request of [
      {
        url: "/api/videos/bulk/creators",
        payload: { videoIds: [130], creatorIds: [42], action: "add" },
      },
      {
        url: "/api/videos/bulk/tags",
        payload: { videoIds: [130], tagIds: [46], action: "add" },
      },
      {
        url: "/api/videos/bulk/studios",
        payload: { videoIds: [130], studioIds: [21], action: "add" },
      },
      {
        url: "/api/videos/bulk/favorites",
        payload: { videoIds: [130], isFavorite: true },
      },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: request.url,
        payload: request.payload,
      });
      expect(response.statusCode, `POST ${request.url}: ${response.body}`).toBe(
        200
      );
    }

    const addCreator = await app.inject({
      method: "POST",
      url: "/api/videos/1/creators",
      payload: { creator_id: 42 },
    });
    expect(addCreator.statusCode, addCreator.body).toBe(201);
    expect(
      (await app.inject({ method: "DELETE", url: "/api/videos/1/creators/42" }))
        .statusCode
    ).toBe(200);

    const addTag = await app.inject({
      method: "POST",
      url: "/api/videos/1/tags",
      payload: { tag_id: 46 },
    });
    expect(addTag.statusCode, addTag.body).toBe(201);
    expect(
      (await app.inject({ method: "DELETE", url: "/api/videos/1/tags/46" }))
        .statusCode
    ).toBe(200);

    sqlite.run("DELETE FROM demo_video_studios WHERE video_id = 1");
    const confirmNone = await app.inject({
      method: "PATCH",
      url: "/api/videos/1/studio-assignment",
      payload: { status: "confirmed_none" },
    });
    expect(confirmNone.statusCode, confirmNone.body).toBe(200);
    expect(confirmNone.json().data.studio_assignment_status).toBe(
      "confirmed_none"
    );

    const confirmedNoneList = await app.inject({
      method: "GET",
      url: "/api/videos?studioAssignmentStatus=confirmed_none&limit=100",
    });
    expect(confirmedNoneList.statusCode, confirmedNoneList.body).toBe(200);
    expect(
      confirmedNoneList
        .json()
        .data.some((video: { id: number }) => video.id === 1)
    ).toBe(true);

    const addStudio = await app.inject({
      method: "POST",
      url: "/api/videos/1/studios/21",
    });
    expect(addStudio.statusCode, addStudio.body).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: "/api/videos/1" })).json().data
        .studio_assignment_status
    ).toBe("assigned");

    const conflictingConfirmation = await app.inject({
      method: "PATCH",
      url: "/api/videos/1/studio-assignment",
      payload: { status: "confirmed_none" },
    });
    expect(conflictingConfirmation.statusCode, conflictingConfirmation.body).toBe(
      409
    );

    const removeStudio = await app.inject({
      method: "DELETE",
      url: "/api/videos/1/studios/21",
    });
    expect(removeStudio.statusCode, removeStudio.body).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: "/api/videos/1" })).json().data
        .studio_assignment_status
    ).toBe("unknown");

    const bulkDelete = await app.inject({
      method: "POST",
      url: "/api/videos/bulk/delete",
      payload: { ids: [131] },
    });
    expect(bulkDelete.statusCode, bulkDelete.body).toBe(200);
    const remove = await app.inject({
      method: "DELETE",
      url: "/api/videos/132",
    });
    expect(remove.statusCode, remove.body).toBe(200);
  });

  it("documents assignment validation and conflict responses", () => {
    const paths = app.swagger().paths as Record<
      string,
      Record<string, { responses?: Record<string, unknown> }>
    >;
    expect(paths["/api/videos/{id}/studio-assignment"]?.patch?.responses)
      .toEqual(expect.objectContaining({
        "200": expect.anything(),
        "400": expect.anything(),
        "401": expect.anything(),
        "404": expect.anything(),
        "409": expect.anything(),
      }));
  });
});
