import { afterAll, beforeAll, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import {
  applyTestDatabaseEnv,
  migrateTestDatabase,
  startTestDatabase,
} from "../helpers/test-database";

let database: Awaited<ReturnType<typeof startTestDatabase>>;
let sql: ReturnType<typeof postgres>;
let root: string;
let service: typeof import("@/modules/conversion/conversion.service").conversionService;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "conversion-record-delete-"));
  process.env.CONVERTED_VIDEOS_DIR = root;
  database = await startTestDatabase();
  applyTestDatabaseEnv(database);
  await migrateTestDatabase();
  sql = postgres(database.connectionString);
  service = (await import("@/modules/conversion/conversion.service"))
    .conversionService;
}, 60_000);

afterAll(async () => {
  if (sql) await sql.end();
  if (database) await database.stop();
  if (root) await rm(root, { recursive: true, force: true });
});

it("removes conversion history without deleting its indexed output media", async () => {
  const output = join(root, "converted.mkv");
  await writeFile(output, "unique synthetic media bytes");
  const [directory] =
    await sql`INSERT INTO watched_directories (path) VALUES (${root}) RETURNING id`;
  const [video] =
    await sql`INSERT INTO videos (file_path, file_name, directory_id, file_size_bytes)
    VALUES (${output}, 'converted.mkv', ${directory.id}, 28) RETURNING id`;
  const [job] =
    await sql`INSERT INTO conversion_jobs (video_id, status, preset, codec, output_path)
    VALUES (${video.id}, 'completed', 'synthetic', 'h264', ${output}) RETURNING id`;
  await service.delete(job.id);
  expect(
    await sql`SELECT id FROM conversion_jobs WHERE id = ${job.id}`
  ).toHaveLength(0);
  expect(await sql`SELECT id FROM videos WHERE id = ${video.id}`).toHaveLength(
    1
  );
  expect(await readFile(output, "utf8")).toBe("unique synthetic media bytes");
});
