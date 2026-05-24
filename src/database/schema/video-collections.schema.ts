import {
  check,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { videosTable } from "./videos.schema";

export const videoCollectionsTable = pgTable(
  "video_collections",
  {
    id: serial("id").primaryKey(),
    title: text("title").notNull(),
    kind: text("kind").notNull(),
    description: text("description"),
    releaseYear: integer("release_year"),
    externalIdsJson: text("external_ids_json"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    titleIdx: index("idx_video_collections_title").on(table.title),
    kindIdx: index("idx_video_collections_kind").on(table.kind),
    releaseYearIdx: index("idx_video_collections_release_year").on(
      table.releaseYear,
    ),
    kindCheck: check(
      "video_collections_kind_check",
      sql`${table.kind} IN ('movie_series', 'tv_series', 'mini_series', 'anthology', 'other')`,
    ),
    releaseYearCheck: check(
      "video_collections_release_year_check",
      sql`${table.releaseYear} IS NULL OR ${table.releaseYear} >= 1800`,
    ),
  }),
);

export const videoCollectionEntriesTable = pgTable(
  "video_collection_entries",
  {
    id: serial("id").primaryKey(),
    collectionId: integer("collection_id")
      .notNull()
      .references(() => videoCollectionsTable.id, { onDelete: "cascade" }),
    videoId: integer("video_id")
      .notNull()
      .references(() => videosTable.id, { onDelete: "cascade" }),
    entryKind: text("entry_kind").notNull(),
    sequenceNumber: integer("sequence_number"),
    seasonNumber: integer("season_number"),
    episodeNumber: integer("episode_number"),
    episodePart: integer("episode_part"),
    absoluteNumber: integer("absolute_number"),
    displayTitleOverride: text("display_title_override"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    uniqueMembership: unique("video_collection_entries_collection_video_unique")
      .on(table.collectionId, table.videoId),
    uniqueVideoMembership: uniqueIndex(
      "video_collection_entries_video_unique",
    ).on(table.videoId),
    collectionIdx: index("idx_video_collection_entries_collection").on(
      table.collectionId,
    ),
    collectionOrderIdx: index("idx_video_collection_entries_collection_order").on(
      table.collectionId,
      table.sequenceNumber,
      table.seasonNumber,
      table.episodeNumber,
      table.episodePart,
      table.absoluteNumber,
    ),
    uniqueSequenceInCollection: uniqueIndex(
      "video_collection_entries_sequence_unique",
    )
      .on(table.collectionId, table.sequenceNumber)
      .where(sql`${table.sequenceNumber} IS NOT NULL`),
    uniqueEpisodeCoordinateInCollection: uniqueIndex(
      "video_collection_entries_episode_unique",
    )
      .on(
        table.collectionId,
        table.seasonNumber,
        table.episodeNumber,
        sql`COALESCE(${table.episodePart}, 0)`,
      )
      .where(
        sql`${table.seasonNumber} IS NOT NULL AND ${table.episodeNumber} IS NOT NULL`,
      ),
    entryKindCheck: check(
      "video_collection_entries_kind_check",
      sql`${table.entryKind} IN ('movie', 'episode', 'special', 'extra')`,
    ),
    sequenceNumberCheck: check(
      "video_collection_entries_sequence_check",
      sql`${table.sequenceNumber} IS NULL OR ${table.sequenceNumber} >= 1`,
    ),
    seasonNumberCheck: check(
      "video_collection_entries_season_check",
      sql`${table.seasonNumber} IS NULL OR ${table.seasonNumber} >= 0`,
    ),
    episodeNumberCheck: check(
      "video_collection_entries_episode_check",
      sql`${table.episodeNumber} IS NULL OR ${table.episodeNumber} >= 1`,
    ),
    episodePartCheck: check(
      "video_collection_entries_episode_part_check",
      sql`${table.episodePart} IS NULL OR ${table.episodePart} >= 1`,
    ),
    absoluteNumberCheck: check(
      "video_collection_entries_absolute_check",
      sql`${table.absoluteNumber} IS NULL OR ${table.absoluteNumber} >= 1`,
    ),
    episodicCoordinateCheck: check(
      "video_collection_entries_episodic_coordinate_check",
      sql`(${table.episodeNumber} IS NULL AND ${table.seasonNumber} IS NULL) OR (${table.episodeNumber} IS NOT NULL AND ${table.seasonNumber} IS NOT NULL)`,
    ),
  }),
);

export type VideoCollectionRecord = typeof videoCollectionsTable.$inferSelect;
export type NewVideoCollectionRecord = typeof videoCollectionsTable.$inferInsert;
export type VideoCollectionEntryRecord =
  typeof videoCollectionEntriesTable.$inferSelect;
export type NewVideoCollectionEntryRecord =
  typeof videoCollectionEntriesTable.$inferInsert;
