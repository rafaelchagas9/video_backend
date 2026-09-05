import { afterAll, beforeAll, expect, it } from "bun:test";
import postgres from "postgres";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql as querySql } from "drizzle-orm";
import { buildVideoFilters } from "@/modules/videos/videos.query-builder";
import { startTestDatabase } from "../helpers/test-database";

let database: Awaited<ReturnType<typeof startTestDatabase>>;
let sql: ReturnType<typeof postgres>;
beforeAll(async () => {
  database = await startTestDatabase();
  sql = postgres(database.connectionString);
  await sql`CREATE TABLE videos (id integer PRIMARY KEY, is_available boolean NOT NULL)`;
  await sql`CREATE TABLE favorites (user_id integer, video_id integer)`;
  await sql`CREATE TABLE thumbnails (id integer, video_id integer)`;
  await sql`INSERT INTO videos VALUES (1,true),(2,true),(3,true),(4,false)`;
  await sql`INSERT INTO favorites VALUES (10,1),(20,2),(10,4)`;
  await sql`INSERT INTO thumbnails VALUES (1,1),(3,3),(4,4)`;
}, 60_000);
afterAll(async () => { if(sql) await sql.end(); if(database) await database.stop(); });

it.each([
  [{ isFavorite: true }, [1]],
  [{ isFavorite: false }, [2, 3]],
  [{ hasThumbnail: true }, [1, 3]],
  [{ hasThumbnail: false }, [2]],
  [{ isFavorite: false, hasThumbnail: true }, [3]],
  [{ isFavorite: true, include_hidden: true }, [1, 4]],
] as const)("honors presence filters shared by list, next, random and triage: %j", async (options, expected) => {
  const { conditions } = buildVideoFilters(10, options);
  const query = new PgDialect().sqlToQuery(querySql`SELECT id FROM videos WHERE ${querySql.join(conditions, querySql` AND `)} ORDER BY id`);
  const rows = await sql.unsafe(query.sql, query.params as never[]);
  expect(rows.map(row => row.id)).toEqual([...expected]);
});
