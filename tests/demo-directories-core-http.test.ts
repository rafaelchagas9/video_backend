import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { rmSync } from "fs";
import { resolve, sep } from "path";
import Fastify from "fastify";
import {
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
    expect(scan.statusCode, scan.body).toBe(200);
    const remove = await app.inject({
      method: "DELETE",
      url: `/api/directories/${id}`,
    });
    expect(remove.statusCode, remove.body).toBe(200);
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

    expect(
      (await app.inject({ method: "POST", url: "/api/videos/1/studios/21" }))
        .statusCode
    ).toBe(200);
    expect(
      (await app.inject({ method: "DELETE", url: "/api/videos/1/studios/21" }))
        .statusCode
    ).toBe(200);

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
});
