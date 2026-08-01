import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { rmSync } from "fs";

process.env.NODE_ENV = "test";
process.env.DEMO_MODE = "true";
process.env.POSTGRES_USER = "demo-boundary-must-not-connect";
process.env.POSTGRES_PASSWORD = "demo-boundary-must-not-connect";
process.env.SESSION_SECRET =
  "demo-production-boundary-session-secret-at-least-32-characters";
process.env.POSTHOG_API_KEY = "";
process.env.POSTHOG_CAPTURE_REQUEST_METRICS = "false";

const databasePath = `/tmp/conversor-video-demo-production-boundary-${process.pid}.sqlite`;

describe("demo production database boundary", () => {
  let app: Awaited<ReturnType<typeof import("@/server").buildServer>>;

  beforeAll(async () => {
    const { env } = await import("@/config/env");
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
  });

  it("does not construct the production PostgreSQL client during server lifecycle", async () => {
    const {
      closeDrizzleDatabase,
      isProductionDatabaseClientInitialized,
    } = await import("@/config/drizzle");
    expect(isProductionDatabaseClientInitialized()).toBe(false);

    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(isProductionDatabaseClientInitialized()).toBe(false);

    await closeDrizzleDatabase();
    expect(isProductionDatabaseClientInitialized()).toBe(false);
  });

  it("fails loudly if demo code accidentally accesses the production database", async () => {
    const { db } = await import("@/config/drizzle");
    expect(() => db.select()).toThrow(
      "Production PostgreSQL access is forbidden in DEMO_MODE",
    );
  });
});
