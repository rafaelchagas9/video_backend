import { afterAll, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { and } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { buildDemoVideoQuery } from "@/database/demo/video-query";
import { buildVideoFilters } from "@/modules/videos/videos.query-builder";
import { listVideosQuerySchema } from "@/modules/videos/videos.schemas";
import type { ListVideosOptions } from "@/modules/videos/videos.types";

const db = new Database(":memory:");
db.exec(
  "CREATE TABLE videos (id INTEGER PRIMARY KEY, directory_id INTEGER, duration_seconds REAL, is_available INTEGER DEFAULT 1); CREATE VIEW demo_videos AS SELECT * FROM videos;"
);
// 1–2 a library folder, 3–4 GoondVR's folder (one short, one long), 5 long with no duration known.
for (const [id, directory, duration] of [
  [1, 1, 60],
  [2, 1, 3600],
  [3, 2, 120],
  [4, 2, 3600],
  [5, 2, null],
] as const)
  db.query("INSERT INTO videos (id, directory_id, duration_seconds) VALUES (?,?,?)").run(id, directory, duration);
afterAll(() => db.close());

const ids = (engine: "demo" | "production SQL", options: ListVideosOptions) => {
  if (engine === "demo") {
    const query = buildDemoVideoQuery({ include_hidden: true, ...options }, 1);
    return db.query(`SELECT v.id FROM demo_videos v ${query.where} ORDER BY v.id`).all(...query.parameters).map((row: any) => row.id);
  }
  const query = new PgDialect().sqlToQuery(and(...buildVideoFilters(1, { include_hidden: true, ...options }).conditions)!);
  return db
    .query(`SELECT videos.id FROM videos WHERE ${query.sql.replace(/\$\d+/g, "?")} ORDER BY videos.id`)
    .all(...(query.params as Array<number | string>))
    .map((row: any) => row.id);
};

it("parses hideRecordings as a boolean query flag", () => {
  expect(listVideosQuerySchema.parse({ hideRecordings: "true" }).hideRecordings).toBe(true);
  expect(listVideosQuerySchema.parse({}).hideRecordings).toBeUndefined();
});

for (const engine of ["demo", "production SQL"] as const) {
  it(`${engine} leaves GoondVR's folder out`, () => {
    expect(ids(engine, { excludeRecordings: { directoryId: 2, minDurationSeconds: null } })).toEqual([1, 2]);
  });

  it(`${engine} leaves out only long videos where recordings share a folder`, () => {
    expect(ids(engine, { excludeRecordings: { directoryId: 2, minDurationSeconds: 900 } })).toEqual([1, 2, 3, 5]);
  });
}
