import { mkdirSync } from "fs";
import { dirname, resolve } from "path";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { env } from "@/config/env";
import * as schema from "./schema";

let sqlite: Database | null = null;
const createDrizzle = (client: Database) => drizzle(client, { schema });
export type DemoDatabase = ReturnType<typeof createDrizzle>;
let database: DemoDatabase | null = null;
let migrationsApplied = false;
let openedPath: string | null = null;
let testDatabasePath: string | null = null;

function configuredDatabasePath(): string {
  if (testDatabasePath) return testDatabasePath;
  return resolve(
    process.cwd(),
    process.env.DEMO_DATABASE_PATH || env.DEMO_DATABASE_PATH
  );
}

export function getDemoDatabasePath(): string {
  return configuredDatabasePath();
}

/**
 * Select an isolated database for a test suite without mutating process-global
 * environment variables while Bun is loading other test modules.
 */
export function setDemoDatabasePathForTests(path: string | null): void {
  if (env.NODE_ENV !== "test" && process.env.NODE_ENV !== "test") {
    throw new Error(
      "Demo test database overrides are only available in test mode"
    );
  }
  closeDemoDatabase();
  testDatabasePath = path ? resolve(process.cwd(), path) : null;
}

export function getDemoSqlite(): Database {
  if (
    !env.DEMO_MODE &&
    env.NODE_ENV !== "test" &&
    process.env.NODE_ENV !== "test" &&
    process.env.DEMO_SQLITE_TOOL !== "true"
  ) {
    throw new Error(
      "Demo SQLite database requested while DEMO_MODE is disabled"
    );
  }
  const path = configuredDatabasePath();
  if (sqlite && openedPath !== path) {
    if (
      env.NODE_ENV !== "test" &&
      process.env.NODE_ENV !== "test" &&
      process.env.DEMO_SQLITE_TOOL !== "true"
    ) {
      throw new Error(
        "DEMO_DATABASE_PATH cannot change while the server is running"
      );
    }
    closeDemoDatabase();
  }
  if (!sqlite) {
    mkdirSync(dirname(path), { recursive: true });
    sqlite = new Database(path, { create: true, strict: true });
    sqlite.exec("PRAGMA foreign_keys = ON");
    sqlite.exec("PRAGMA journal_mode = WAL");
    sqlite.exec("PRAGMA synchronous = NORMAL");
    sqlite.exec("PRAGMA busy_timeout = 5000");
    database = createDrizzle(sqlite);
    openedPath = path;
  }
  return sqlite;
}

export function getDemoDatabase(): DemoDatabase {
  getDemoSqlite();
  return database!;
}

export function withDemoTransaction<T>(callback: () => T): T {
  const sqlite = getDemoSqlite();
  // Service-level operations compose smaller transactional helpers. Reuse the
  // active outer transaction so the complete operation commits or rolls back
  // as one unit instead of attempting a nested BEGIN IMMEDIATE.
  if (sqlite.inTransaction) return callback();
  return sqlite.transaction(callback).immediate();
}

export function initializeDemoDatabase(): void {
  const db = getDemoDatabase();
  if (!migrationsApplied) {
    migrate(db, {
      migrationsFolder: resolve(process.cwd(), "src/database/demo/migrations"),
    });
    migrationsApplied = true;
  }
  const check = getDemoSqlite()
    .query<{ quick_check: string }, []>("PRAGMA quick_check")
    .get();
  if (check?.quick_check !== "ok") {
    throw new Error(
      `Demo SQLite quick_check failed: ${check?.quick_check ?? "unknown"}`
    );
  }
}

export function closeDemoDatabase(): void {
  sqlite?.close(false);
  sqlite = null;
  database = null;
  migrationsApplied = false;
  openedPath = null;
}
