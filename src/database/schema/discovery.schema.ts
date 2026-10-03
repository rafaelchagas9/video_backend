import { integer, pgTable, real, smallint, timestamp } from "drizzle-orm/pg-core";
import { videosTable } from "./videos.schema";

/**
 * How often each stretch of a video has been watched ("most replayed"). Clients already
 * report contiguous watched seconds plus the position they ended at, so every report adds
 * one pass over [position - watched, position]. Buckets are fixed-width seconds.
 */
export const videoWatchHeatTable = pgTable("video_watch_heat", {
  videoId: integer("video_id")
    .primaryKey()
    .references(() => videosTable.id, { onDelete: "cascade" }),
  bucketSeconds: smallint("bucket_seconds").notNull().default(5),
  buckets: real("buckets").array().notNull(),
  /** Seconds of watching recorded, for telling a real pattern from one stray play. */
  watchedSeconds: real("watched_seconds").notNull().default(0),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
