import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { videosTable } from "./videos.schema";

/**
 * Hashes stash-box servers index, per video. `origin` says where a hash came
 * from: `pre_conversion` is the original file's OSHASH, captured before a
 * conversion replaced it (only pHash survives a re-encode); `stash` is copied
 * from the linked Stash scene's current file.
 */
export const videoFingerprintsTable = pgTable(
  "video_fingerprints",
  {
    videoId: integer("video_id")
      .notNull()
      .references(() => videosTable.id, { onDelete: "cascade" }),
    // OSHASH | MD5 | PHASH
    algorithm: text("algorithm").notNull(),
    hash: text("hash").notNull(),
    // pre_conversion | stash
    origin: text("origin").notNull(),
    durationSeconds: real("duration_seconds"),
    filePath: text("file_path"),
    recordedAt: timestamp("recorded_at").defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.videoId, table.algorithm, table.hash] }),
    originIdx: index("idx_video_fingerprints_origin").on(table.origin),
  })
);

/**
 * The Stash scene that holds a video's current file. Stash scans the same
 * paths Kura serves (mounted read-only at the same absolute path), so the
 * link is found by exact path.
 */
export const stashSceneLinksTable = pgTable("stash_scene_links", {
  videoId: integer("video_id")
    .primaryKey()
    .references(() => videosTable.id, { onDelete: "cascade" }),
  stashSceneId: text("stash_scene_id").notNull(),
  stashFileId: text("stash_file_id").notNull(),
  filePath: text("file_path").notNull(),
  hasPhash: boolean("has_phash").default(false).notNull(),
  syncedAt: timestamp("synced_at").defaultNow().notNull(),
});

/** One batch identify run over many videos (a durable job). */
export const identifyRunsTable = pgTable("identify_runs", {
  id: serial("id").primaryKey(),
  // queued | running | completed | failed | cancelled
  status: text("status").notNull(),
  dryRun: boolean("dry_run").notNull(),
  options: jsonb("options").notNull(),
  filter: jsonb("filter").notNull(),
  // { total, processed, applied, queued, no_match, unlinked, errors }
  counts: jsonb("counts").notNull(),
  durableJobId: integer("durable_job_id"),
  error: text("error"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  startedAt: timestamp("started_at"),
  finishedAt: timestamp("finished_at"),
});

/** What a run did (or, in a dry run, would do) to each video. */
export const identifyRunItemsTable = pgTable(
  "identify_run_items",
  {
    id: serial("id").primaryKey(),
    runId: integer("run_id")
      .notNull()
      .references(() => identifyRunsTable.id, { onDelete: "cascade" }),
    videoId: integer("video_id").notNull(),
    // applied | queued | no_match | unlinked | error
    outcome: text("outcome").notNull(),
    source: text("source"),
    externalId: text("external_id"),
    // reason, evidence, applied suggestion ids, error message
    detail: jsonb("detail"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    runIdx: index("idx_identify_run_items_run").on(table.runId, table.outcome),
    videoIdx: index("idx_identify_run_items_video").on(table.videoId),
  })
);

export type VideoFingerprint = typeof videoFingerprintsTable.$inferSelect;
export type StashSceneLink = typeof stashSceneLinksTable.$inferSelect;
export type IdentifyRun = typeof identifyRunsTable.$inferSelect;
export type IdentifyRunItem = typeof identifyRunItemsTable.$inferSelect;
