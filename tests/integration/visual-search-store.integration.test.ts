import { afterAll, beforeAll, expect, it } from "bun:test";
import postgres from "postgres";
import {
  applyTestDatabaseEnv,
  assertTestDatabaseEnvironment,
  startTestDatabase,
} from "../helpers/test-database";
import type {
  FrameRow,
  IndexedVideo,
  PostgresVisualSearchStore,
} from "@/modules/visual-search/visual-search.store";

let database: Awaited<ReturnType<typeof startTestDatabase>>;
let client: ReturnType<typeof postgres>;
let store: PostgresVisualSearchStore;

beforeAll(async () => {
  database = await startTestDatabase();
  applyTestDatabaseEnv(database);
  const { env } = await import("@/config/env");
  assertTestDatabaseEnvironment(database, env);
  client = postgres(database.connectionString, { max: 1 });
  await client`CREATE EXTENSION vector`;
  await client`CREATE TABLE video_frame_embeddings (
    video_id integer NOT NULL, frame_index integer NOT NULL,
    timestamp_seconds real NOT NULL, embedding halfvec(1152) NOT NULL,
    PRIMARY KEY (video_id, frame_index)
  )`;
  await client`CREATE TABLE video_visual_index (
    video_id integer PRIMARY KEY, model_revision text NOT NULL,
    storyboard_generated_at timestamp NOT NULL, interval_seconds real NOT NULL,
    frame_count integer NOT NULL, indexed_at timestamp NOT NULL DEFAULT now()
  )`;
  const { PostgresVisualSearchStore } =
    await import("@/modules/visual-search/visual-search.store");
  store = new PostgresVisualSearchStore();
}, 60_000);

afterAll(async () => {
  const { closeDrizzleDatabase } = await import("@/config/drizzle");
  await closeDrizzleDatabase();
  await client?.end({ timeout: 1 });
  await database?.stop();
});

function meta(videoId: number, frameCount: number): IndexedVideo {
  return {
    videoId,
    frameCount,
    modelRevision: "test-model",
    storyboardGeneratedAt: new Date("2026-10-11T00:00:00Z"),
    intervalSeconds: 10,
  };
}

function frames(count: number, dimension = 1152): FrameRow[] {
  return Array.from({ length: count }, (_, frameIndex) => ({
    frameIndex,
    timestampSeconds: frameIndex * 10,
    vector: new Uint16Array(dimension).fill(0x3c00),
  }));
}

it("serializes concurrent first-time replacements without duplicate frame errors", async () => {
  // Pause both writers after their DELETE on the empty video. Without a
  // per-video transaction lock, both try to INSERT frame zero concurrently.
  await client`CREATE FUNCTION pause_visual_insert() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.frame_index = 0 THEN PERFORM pg_sleep(0.2); END IF; RETURN NEW; END;
  $$`;
  await client`CREATE TRIGGER pause_visual_insert BEFORE INSERT ON video_frame_embeddings
    FOR EACH ROW EXECUTE FUNCTION pause_visual_insert()`;
  try {
    const results = await Promise.allSettled([
      store.replaceVideo(meta(6337, 1), frames(1)),
      store.replaceVideo(meta(6337, 2), frames(2)),
    ]);
    expect(results.map((result) => result.status)).toEqual([
      "fulfilled",
      "fulfilled",
    ]);
    const [indexed] =
      await client`SELECT frame_count FROM video_visual_index WHERE video_id=6337`;
    const rows =
      await client`SELECT frame_index FROM video_frame_embeddings WHERE video_id=6337 ORDER BY frame_index`;
    expect(rows.length).toBe(indexed!.frame_count);
    expect(rows.map((row) => row.frame_index)).toEqual(
      Array.from({ length: indexed!.frame_count }, (_, index) => index)
    );
  } finally {
    await client`DROP TRIGGER pause_visual_insert ON video_frame_embeddings`;
    await client`DROP FUNCTION pause_visual_insert()`;
  }
}, 10_000);

it("preserves the old index on failure and releases the video lock for a retry", async () => {
  await store.replaceVideo(meta(42, 1), frames(1));
  await expect(store.replaceVideo(meta(42, 2), frames(2, 8))).rejects.toThrow();
  expect(
    (
      await client`SELECT frame_count FROM video_visual_index WHERE video_id=42`
    )[0]!.frame_count
  ).toBe(1);
  expect(
    (
      await client`SELECT count(*)::int AS count FROM video_frame_embeddings WHERE video_id=42`
    )[0]!.count
  ).toBe(1);
  await store.replaceVideo(meta(42, 2), frames(2));
  expect(
    (
      await client`SELECT count(*)::int AS count FROM video_frame_embeddings WHERE video_id=42`
    )[0]!.count
  ).toBe(2);
});
