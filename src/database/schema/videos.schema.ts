import {
  pgTable,
  serial,
  text,
  integer,
  real,
  boolean,
  timestamp,
  index,
  primaryKey,
  unique,
} from "drizzle-orm/pg-core";
import { watchedDirectoriesTable } from "./directories.schema";
import { usersTable } from "./users.schema";

// Videos table (core media information)
export const videosTable = pgTable(
  "videos",
  {
    id: serial("id").primaryKey(),
    filePath: text("file_path").notNull().unique(),
    fileName: text("file_name").notNull(),
    directoryId: integer("directory_id")
      .notNull()
      .references(() => watchedDirectoriesTable.id, { onDelete: "cascade" }),

    // File metadata
    fileSizeBytes: integer("file_size_bytes").notNull(),
    fileHash: text("file_hash"),

    // Video metadata (extracted)
    durationSeconds: real("duration_seconds"),
    width: integer("width"),
    height: integer("height"),
    codec: text("codec"),
    bitrate: integer("bitrate"),
    fps: real("fps"),
    audioCodec: text("audio_codec"),

    // User-editable metadata
    title: text("title"),
    description: text("description"),
    themes: text("themes"),

    // Status tracking
    isAvailable: boolean("is_available").default(true).notNull(),
    lastVerifiedAt: timestamp("last_verified_at"),
    studioAbsenceConfirmedAt: timestamp("studio_absence_confirmed_at"),
    indexedAt: timestamp("indexed_at").defaultNow().notNull(),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    directoryIdx: index("idx_videos_directory").on(table.directoryId),
    filePathIdx: index("idx_videos_file_path").on(table.filePath),
    fileHashIdx: index("idx_videos_file_hash").on(table.fileHash),
    isAvailableIdx: index("idx_videos_is_available").on(table.isAvailable),
  }),
);

// Video statistics (per-user watch data)
export const videoStatsTable = pgTable(
  "video_stats",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    videoId: integer("video_id")
      .notNull()
      .references(() => videosTable.id, { onDelete: "cascade" }),
    playCount: integer("play_count").default(0).notNull(),
    totalWatchSeconds: real("total_watch_seconds").default(0).notNull(),
    sessionWatchSeconds: real("session_watch_seconds").default(0).notNull(),
    sessionPlayCounted: boolean("session_play_counted")
      .default(false)
      .notNull(),
    lastPositionSeconds: real("last_position_seconds"),
    lastPlayedAt: timestamp("last_played_at"),
    lastWatchAt: timestamp("last_watch_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.videoId] }),
    uniqueUserVideo: unique("video_stats_user_video_unique").on(
      table.userId,
      table.videoId,
    ),
    videoIdx: index("idx_video_stats_video").on(table.videoId),
    userIdx: index("idx_video_stats_user").on(table.userId),
    lastPlayedIdx: index("idx_video_stats_last_played").on(table.lastPlayedAt),
  }),
);

// Custom metadata (arbitrary key-value pairs)
export const videoMetadataTable = pgTable(
  "video_metadata",
  {
    id: serial("id").primaryKey(),
    videoId: integer("video_id")
      .notNull()
      .references(() => videosTable.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: text("value").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    videoKeyUnique: unique("video_metadata_video_id_key_unique").on(
      table.videoId,
      table.key,
    ),
    videoKeyIdx: index("idx_video_metadata_video_key").on(table.videoId, table.key),
  }),
);

// Cached related-video scores (source -> candidate)
export const videoRelatedScoresTable = pgTable(
  "video_related_scores",
  {
    sourceVideoId: integer("source_video_id")
      .notNull()
      .references(() => videosTable.id, { onDelete: "cascade" }),
    relatedVideoId: integer("related_video_id")
      .notNull()
      .references(() => videosTable.id, { onDelete: "cascade" }),
    score: real("score").notNull(),
    reasonsJson: text("reasons_json").notNull(),
    computedAt: timestamp("computed_at").defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.sourceVideoId, table.relatedVideoId] }),
    sourceScoreIdx: index("idx_video_related_scores_source_score").on(
      table.sourceVideoId,
      table.score,
    ),
    sourceComputedIdx: index("idx_video_related_scores_source_computed").on(
      table.sourceVideoId,
      table.computedAt,
    ),
    relatedIdx: index("idx_video_related_scores_related").on(
      table.relatedVideoId,
    ),
  }),
);

// External identity per source for scenes (videos) — mirrors creator_external_ids.
// Lets accepted scene matches be re-fetched / deduped / skip-requeried.
export const videoExternalIdsTable = pgTable(
  "video_external_ids",
  {
    id: serial("id").primaryKey(),
    videoId: integer("video_id")
      .notNull()
      .references(() => videosTable.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    externalId: text("external_id").notNull(),
    externalUrl: text("external_url"),
    lastSyncedAt: timestamp("last_synced_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    videoIdx: index("idx_video_external_ids_video").on(table.videoId),
    uniqueSourceExternal: unique("unique_video_external_id").on(
      table.source,
      table.externalId,
    ),
  }),
);

// Inferred types
export type Video = typeof videosTable.$inferSelect;
export type NewVideo = typeof videosTable.$inferInsert;
export type VideoStats = typeof videoStatsTable.$inferSelect;
export type NewVideoStats = typeof videoStatsTable.$inferInsert;
export type VideoMetadata = typeof videoMetadataTable.$inferSelect;
export type NewVideoMetadata = typeof videoMetadataTable.$inferInsert;
export type VideoRelatedScore = typeof videoRelatedScoresTable.$inferSelect;
export type NewVideoRelatedScore = typeof videoRelatedScoresTable.$inferInsert;
export type VideoExternalId = typeof videoExternalIdsTable.$inferSelect;
export type NewVideoExternalId = typeof videoExternalIdsTable.$inferInsert;
