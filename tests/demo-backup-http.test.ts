import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { rmSync } from "fs";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";

process.env.NODE_ENV = "test";
process.env.POSTGRES_USER ||= "demo-backup-test";
process.env.POSTGRES_PASSWORD ||= "demo-backup-test";
process.env.SESSION_SECRET ||=
  "demo-backup-session-secret-at-least-32-characters";
process.env.POSTHOG_API_KEY = "";
process.env.POSTHOG_CAPTURE_REQUEST_METRICS = "false";

const databasePath = `/tmp/conversor-video-demo-backup-http-${process.pid}.sqlite`;

describe("demo backup HTTP contracts", () => {
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
    ]) {
      rmSync(path, { force: true });
    }
    demo.importDemoJsonFile(undefined, { reset: true });
    sqlite = demo.getDemoSqlite();

    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const { backupRoutes } = await import("@/modules/backup/backup.routes");
    await app.register(backupRoutes, { prefix: "/api/backup" });
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
    ]) {
      rmSync(path, { force: true });
    }
    const { env } = await import("@/config/env");
    env.DEMO_MODE = originalDemoMode;
  });

  it("creates, lists, exports, restores, and deletes an SQLite-only backup", async () => {
    const create = await app.inject({ method: "POST", url: "/api/backup" });
    expect(create.statusCode, create.body).toBe(201);
    const backup = create.json().data as { filename: string; path: string };
    expect(backup.path).toBe(`demo://backups/${backup.filename}`);

    const list = await app.inject({ method: "GET", url: "/api/backup" });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().data).toHaveLength(1);

    const exported = await app.inject({
      method: "GET",
      url: "/api/backup/export",
    });
    expect(exported.statusCode, exported.body).toBe(200);
    expect(exported.headers["content-type"]).toContain("application/json");
    expect(exported.json()).toMatchObject({
      version: "0.1.0-demo-sqlite",
      tables: { videos: expect.any(Array), creators: expect.any(Array) },
    });

    const originalTitle = sqlite
      .query<
        { title: string },
        []
      >("SELECT title FROM demo_videos WHERE id = 1")
      .get()!.title;
    sqlite.run("UPDATE demo_videos SET title = ? WHERE id = 1", [
      "Changed after HTTP backup",
    ]);
    const restore = await app.inject({
      method: "POST",
      url: `/api/backup/${backup.filename}/restore`,
    });
    expect(restore.statusCode, restore.body).toBe(200);
    expect(
      sqlite
        .query<
          { title: string },
          []
        >("SELECT title FROM demo_videos WHERE id = 1")
        .get()!.title
    ).toBe(originalTitle);

    const remove = await app.inject({
      method: "DELETE",
      url: `/api/backup/${backup.filename}`,
    });
    expect(remove.statusCode, remove.body).toBe(200);
    const empty = await app.inject({ method: "GET", url: "/api/backup" });
    expect(empty.json().data).toEqual([]);
  });
});
