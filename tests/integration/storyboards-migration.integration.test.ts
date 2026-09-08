import { afterAll, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { startTestDatabase } from "../helpers/test-database";

const database = await startTestDatabase();
const sql = postgres(database.connectionString, { max: 1 });
afterAll(async () => {
  await sql.end({ timeout: 5 });
  await database.stop();
});

it("repairs the legacy publication failure, archives duplicates, and permits repeated upserts", async () => {
  await sql`CREATE TABLE storyboards (
    id serial PRIMARY KEY, video_id integer NOT NULL, sprite_path text NOT NULL,
    vtt_path text NOT NULL, generated_at timestamp
  )`;
  await sql`INSERT INTO storyboards(video_id,sprite_path,vtt_path,generated_at) VALUES
    (42,'old.webp','old.vtt','2026-01-01'),
    (42,'new.webp','new.vtt','2026-01-02'),
    (43,'tie-first.webp','first.vtt','2026-01-01'),
    (43,'tie-last.webp','last.vtt','2026-01-01'),
    (44,'only.webp','only.vtt',null)`;
  const original = await sql`SELECT * FROM storyboards ORDER BY id`;
  const upsert =
    () => sql`INSERT INTO storyboards(video_id,sprite_path,vtt_path) VALUES (5333,'generated.webp','generated.vtt')
    ON CONFLICT(video_id) DO UPDATE SET sprite_path=excluded.sprite_path RETURNING id`;
  let failure: unknown;
  try {
    await upsert();
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({ code: "42P10" });
  const migration = await readFile(
    "src/database/drizzle-migrations/0044_storyboard_video_unique.sql",
    "utf8"
  );
  await sql.begin(async (tx) => {
    await tx.unsafe(migration);
  });
  expect(Array.from(await sql`SELECT id FROM storyboards ORDER BY id`)).toEqual(
    [{ id: 2 }, { id: 4 }, { id: 5 }]
  );
  const archived =
    await sql`SELECT original_id,retained_id,row_data FROM maintenance.storyboard_duplicates_0044 ORDER BY original_id`;
  expect(archived.map((row) => [row.original_id, row.retained_id])).toEqual([
    [1, 2],
    [3, 4],
  ]);
  expect(archived.map((row) => row.row_data.sprite_path)).toEqual([
    original[0]!.sprite_path,
    original[2]!.sprite_path,
  ]);
  const first = await upsert();
  expect(await upsert()).toEqual(first);
  // Safe on schemas that already have the constraint, including replay.
  await sql.begin(async (tx) => {
    await tx.unsafe(migration);
  });
  expect(
    (
      await sql`SELECT count(*)::int AS count FROM storyboards WHERE video_id=5333`
    )[0]!.count
  ).toBe(1);
  expect(
    (
      await sql`SELECT count(*)::int AS count FROM maintenance.storyboard_duplicates_0044`
    )[0]!.count
  ).toBe(2);
}, 30_000);
