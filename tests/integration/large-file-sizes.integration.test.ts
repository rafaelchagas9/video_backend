import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, expect, it } from "bun:test";
import postgres from "postgres";
import {
  applyTestDatabaseEnv,
  migrateTestDatabase,
  startTestDatabase,
} from "../helpers/test-database";

let database: Awaited<ReturnType<typeof startTestDatabase>>;
let sql: ReturnType<typeof postgres>;
beforeAll(async () => {
  database = await startTestDatabase();
  applyTestDatabaseEnv(database);
  sql = postgres(database.connectionString);
  await migrateTestDatabase();
}, 60_000);
afterAll(async () => {
  if (sql) await sql.end();
  if (database) await database.stop();
});

it("persists large video and library byte sizes without 32-bit overflow", async () => {
  const [{ id }] =
    await sql`INSERT INTO watched_directories (path) VALUES ('/synthetic') RETURNING id`;
  const size = 8 * 1024 ** 3 + 123;
  const [{ file_size_bytes }] = await sql`
    INSERT INTO videos (file_path, file_name, directory_id, file_size_bytes)
    VALUES ('/synthetic/large.mkv', 'large.mkv', ${id}, ${size})
    RETURNING file_size_bytes
  `;
  expect(Number(file_size_bytes)).toBe(size);
  const [{ total_video_size_bytes }] = await sql`
    INSERT INTO stats_storage_snapshots (total_video_size_bytes, total_video_count)
    VALUES (${size * 1000}, 1000) RETURNING total_video_size_bytes
  `;
  expect(Number(total_video_size_bytes)).toBe(size * 1000);
});

it("replays the byte-size migration without changing old data or constraints", async () => {
  const columns: Record<string, string[]> = {
    videos: ["file_size_bytes"],
    artwork_assets: ["file_size_bytes"],
    storyboards: ["sprite_size_bytes"],
    thumbnails: ["file_size_bytes"],
    stats_library_snapshots: ["total_size_bytes", "average_size_bytes"],
    stats_storage_snapshots: [
      "total_video_size_bytes",
      "thumbnails_size_bytes",
      "storyboards_size_bytes",
      "profile_pictures_size_bytes",
      "converted_size_bytes",
      "faces_size_bytes",
      "database_size_bytes",
    ],
    face_images: ["file_size_bytes"],
  };
  await sql.begin(async (tx) => {
    await tx.unsafe("CREATE SCHEMA historical_bytes");
    await tx.unsafe("SET LOCAL search_path TO historical_bytes");
    for (const [table, names] of Object.entries(columns)) {
      await tx.unsafe(
        `CREATE TABLE ${table} (id integer PRIMARY KEY, ${names.map((name) => `${name} integer NOT NULL DEFAULT 0`).join(", ")})`
      );
      await tx.unsafe(
        `INSERT INTO ${table} (id, ${names.join(", ")}) VALUES (1, ${names.map(() => "2048").join(", ")})`
      );
    }
    await expect(
      tx.savepoint(
        async (savepoint) =>
          await savepoint.unsafe(
            "INSERT INTO videos (id, file_size_bytes) VALUES (2, 8589934592)"
          )
      )
    ).rejects.toMatchObject({ code: "22003" });
    const migration = await readFile(
      "src/database/drizzle-migrations/0043_smooth_ultimatum.sql",
      "utf8"
    );
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await tx.unsafe(statement);
    }
    for (const [table, names] of Object.entries(columns)) {
      const [old] = await tx.unsafe(`SELECT * FROM ${table} WHERE id = 1`);
      for (const name of names) expect(Number(old![name])).toBe(2048);
      await tx.unsafe(
        `INSERT INTO ${table} (id, ${names.join(", ")}) VALUES (2, ${names.map(() => "8589934592").join(", ")})`
      );
      const [large] = await tx.unsafe(`SELECT * FROM ${table} WHERE id = 2`);
      for (const name of names) expect(Number(large![name])).toBe(8589934592);
    }
    const types = await tx.unsafe(
      "SELECT data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'historical_bytes' AND column_name <> 'id'"
    );
    expect(types).toHaveLength(14);
    for (const column of types)
      expect(column).toMatchObject({
        data_type: "bigint",
        is_nullable: "NO",
        column_default: "0",
      });
  });
});
