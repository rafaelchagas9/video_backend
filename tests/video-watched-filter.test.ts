import { afterAll, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { and } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { buildDemoVideoQuery } from "@/database/demo/video-query";
import { buildVideoFilters } from "@/modules/videos/videos.query-builder";
import {
  listVideosQuerySchema,
  randomVideoQuerySchema,
} from "@/modules/videos/videos.schemas";

const db = new Database(":memory:");
db.exec(
  "CREATE TABLE videos (id INTEGER PRIMARY KEY, duration_seconds REAL); CREATE TABLE video_stats (video_id INTEGER, user_id INTEGER, play_count INTEGER, last_position_seconds REAL); CREATE VIEW demo_videos AS SELECT * FROM videos; CREATE VIEW demo_video_stats AS SELECT * FROM video_stats;"
);
// Missing stats, cleared progress, manual completion, counted reset, unplayed reset,
// partial playback, missing duration, and the exact completion boundary.
for (let id = 1; id <= 8; id++)
  db.query("INSERT INTO videos VALUES (?,?)").run(id, id === 7 ? null : 100);
for (const [id, count, position] of [
  [2, 3, null],
  [3, 0, 100],
  [4, 1, 0],
  [5, 0, 0],
  [6, 3, 94],
  [7, 0, 100],
  [8, 0, 95],
]) {
  db.query("INSERT INTO video_stats VALUES (?,1,?,?)").run(
    id ?? null,
    count ?? null,
    position ?? null
  );
}
db.exec("INSERT INTO video_stats VALUES (1,2,0,100)");
afterAll(() => db.close());

it("accepts explicit true/false watched filters on both list and random contracts", () => {
  for (const schema of [listVideosQuerySchema, randomVideoQuerySchema]) {
    expect(schema.parse({ isWatched: "false" }).isWatched).toBe(false);
    expect(schema.parse({ isWatched: "true" }).isWatched).toBe(true);
    expect(schema.parse({}).isWatched).toBeUndefined();
    expect(schema.safeParse({ isWatched: "maybe" }).success).toBe(false);
  }
});
for (const engine of ["demo", "production SQL"] as const) {
  it(`${engine} includes absent/cleared progress and excludes manual completion per user`, () => {
    const select = (userId: number, isWatched: boolean) => {
      if (engine === "demo") {
        const query = buildDemoVideoQuery(
          { include_hidden: true, isWatched },
          userId
        );
        return db
          .query(`SELECT v.id FROM demo_videos v ${query.where} ORDER BY v.id`)
          .all(...query.parameters);
      }
      const query = new PgDialect().sqlToQuery(
        and(
          ...buildVideoFilters(userId, { include_hidden: true, isWatched })
            .conditions
        )!
      );
      // Execute the generated portable EXISTS predicate over identical fixtures.
      // PostgreSQL's positional placeholders are adapted; no production DB is used.
      return db
        .query(
          `SELECT videos.id FROM videos WHERE ${query.sql.replace(/\$\d+/g, "?")} ORDER BY videos.id`
        )
        .all(...(query.params as Array<number | string>));
    };
    expect(select(1, true)).toEqual([{ id: 3 }, { id: 4 }, { id: 8 }]);
    expect(select(1, false)).toEqual([
      { id: 1 },
      { id: 2 },
      { id: 5 },
      { id: 6 },
      { id: 7 },
    ]);
    expect(select(2, true)).toEqual([{ id: 1 }]);
    expect(select(2, false)).toHaveLength(7);
  });
}
