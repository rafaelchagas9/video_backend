import {
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  real,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./users.schema";
import { videosTable } from "./videos.schema";
import { creatorsTable } from "./organization.schema";
import { contentAnalysisRunsTable } from "./content-analysis-runs.schema";

// Playlists table
export const playlistsTable = pgTable(
  "playlists",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    artworkSourceVideoId: integer("artwork_source_video_id").references(
      () => videosTable.id,
      { onDelete: "set null" }
    ),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    userIdx: index("idx_playlists_user").on(table.userId),
    artworkSourceIdx: index("idx_playlists_artwork_source").on(
      table.artworkSourceVideoId
    ),
  })
);

// Playlist-Video relationship (many-to-many with position)
export const playlistVideosTable = pgTable(
  "playlist_videos",
  {
    playlistId: integer("playlist_id")
      .notNull()
      .references(() => playlistsTable.id, { onDelete: "cascade" }),
    videoId: integer("video_id")
      .notNull()
      .references(() => videosTable.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    addedAt: timestamp("added_at").defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.playlistId, table.videoId] }),
    playlistPositionIdx: index("idx_playlist_videos_playlist").on(
      table.playlistId,
      table.position
    ),
  })
);

// Favorites table
export const favoritesTable = pgTable(
  "favorites",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    videoId: integer("video_id")
      .notNull()
      .references(() => videosTable.id, { onDelete: "cascade" }),
    addedAt: timestamp("added_at").defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.videoId] }),
    userIdx: index("idx_favorites_user").on(table.userId),
  })
);

// Creator favorites table
export const creatorFavoritesTable = pgTable(
  "creator_favorites",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    creatorId: integer("creator_id")
      .notNull()
      .references(() => creatorsTable.id, { onDelete: "cascade" }),
    addedAt: timestamp("added_at").defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.creatorId] }),
    userIdx: index("idx_creator_favorites_user").on(table.userId),
    creatorIdx: index("idx_creator_favorites_creator").on(table.creatorId),
  })
);

// Bookmarks table
export const bookmarksTable = pgTable(
  "bookmarks",
  {
    id: serial("id").primaryKey(),
    videoId: integer("video_id")
      .notNull()
      .references(() => videosTable.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    timestampSeconds: real("timestamp_seconds").notNull(),
    endTimestampSeconds: real("end_timestamp_seconds"),
    peakTimestampSeconds: real("peak_timestamp_seconds"),
    origin: text("origin").notNull().default("manual"),
    analysisRunId: integer("analysis_run_id").references(
      () => contentAnalysisRunsTable.id,
      { onDelete: "restrict" }
    ),
    userModifiedAt: timestamp("user_modified_at"),
    name: text("name").notNull(),
    description: text("description"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    videoTimestampIdx: index("idx_bookmarks_video").on(
      table.videoId,
      table.timestampSeconds
    ),
    userIdx: index("idx_bookmarks_user").on(table.userId),
    originIdx: index("idx_bookmarks_origin").on(table.origin),
    analysisRunIdx: index("idx_bookmarks_analysis_run").on(table.analysisRunId),
    originCheck: check(
      "bookmarks_origin_check",
      sql`${table.origin} IN ('manual', 'automatic')`
    ),
    timestampCheck: check(
      "bookmarks_timestamp_check",
      sql`${table.timestampSeconds} >= 0`
    ),
    intervalCheck: check(
      "bookmarks_interval_check",
      sql`(${table.endTimestampSeconds} IS NULL AND ${table.peakTimestampSeconds} IS NULL) OR (${table.endTimestampSeconds} IS NOT NULL AND ${table.peakTimestampSeconds} IS NOT NULL AND ${table.timestampSeconds} <= ${table.peakTimestampSeconds} AND ${table.peakTimestampSeconds} <= ${table.endTimestampSeconds})`
    ),
    provenanceCheck: check(
      "bookmarks_provenance_check",
      sql`(${table.origin} = 'manual' AND ${table.analysisRunId} IS NULL) OR (${table.origin} = 'automatic' AND ${table.analysisRunId} IS NOT NULL)`
    ),
  })
);

export const bookmarkCategoriesTable = pgTable(
  "bookmark_categories",
  {
    id: serial("id").primaryKey(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    kind: text("kind").notNull().default("custom"),
    userId: integer("user_id").references(() => usersTable.id, {
      onDelete: "cascade",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    systemKeyUnique: uniqueIndex("bookmark_categories_system_key_unique")
      .on(table.key)
      .where(sql`${table.kind} = 'system'`),
    customUserKeyUnique: uniqueIndex(
      "bookmark_categories_custom_user_key_unique"
    )
      .on(table.userId, table.key)
      .where(sql`${table.kind} = 'custom'`),
    userIdx: index("idx_bookmark_categories_user").on(table.userId),
    ownershipCheck: check(
      "bookmark_categories_ownership_check",
      sql`(${table.kind} = 'system' AND ${table.userId} IS NULL) OR (${table.kind} = 'custom' AND ${table.userId} IS NOT NULL)`
    ),
    reservedSystemKeyCheck: check(
      "bookmark_categories_reserved_system_key_check",
      sql`${table.kind} = 'system' OR ${table.key} NOT IN ('BUTTOCKS_EXPOSED', 'FEMALE_BREAST_EXPOSED', 'FEMALE_GENITALIA_EXPOSED', 'MALE_BREAST_EXPOSED', 'ANUS_EXPOSED', 'FEET_EXPOSED', 'ARMPITS_EXPOSED', 'BELLY_EXPOSED', 'MALE_GENITALIA_EXPOSED', 'ANUS_COVERED', 'FEMALE_GENITALIA_COVERED')`
    ),
  })
);

export const bookmarkCategoryAssignmentsTable = pgTable(
  "bookmark_category_assignments",
  {
    bookmarkId: integer("bookmark_id")
      .notNull()
      .references(() => bookmarksTable.id, { onDelete: "cascade" }),
    categoryId: integer("category_id")
      .notNull()
      .references(() => bookmarkCategoriesTable.id, { onDelete: "cascade" }),
    confidence: real("confidence"),
    providerLabel: text("provider_label"),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.bookmarkId, table.categoryId] }),
    categoryIdx: index("idx_bookmark_category_assignments_category").on(
      table.categoryId
    ),
    confidenceCheck: check(
      "bookmark_category_assignments_confidence_check",
      sql`${table.confidence} IS NULL OR (${table.confidence} >= 0 AND ${table.confidence} <= 1)`
    ),
  })
);

// Ratings table
export const ratingsTable = pgTable(
  "ratings",
  {
    id: serial("id").primaryKey(),
    videoId: integer("video_id")
      .notNull()
      .references(() => videosTable.id, { onDelete: "cascade" }),
    rating: integer("rating").notNull(),
    comment: text("comment"),
    ratedAt: timestamp("rated_at").defaultNow().notNull(),
  },
  (table) => ({
    videoIdx: index("idx_ratings_video").on(table.videoId),
    ratingCheck: check("rating_check", sql`rating >= 1 AND rating <= 5`),
  })
);

// Inferred types
export type Playlist = typeof playlistsTable.$inferSelect;
export type NewPlaylist = typeof playlistsTable.$inferInsert;
export type PlaylistVideo = typeof playlistVideosTable.$inferSelect;
export type NewPlaylistVideo = typeof playlistVideosTable.$inferInsert;
export type Favorite = typeof favoritesTable.$inferSelect;
export type NewFavorite = typeof favoritesTable.$inferInsert;
export type CreatorFavorite = typeof creatorFavoritesTable.$inferSelect;
export type NewCreatorFavorite = typeof creatorFavoritesTable.$inferInsert;
export type Bookmark = typeof bookmarksTable.$inferSelect;
export type NewBookmark = typeof bookmarksTable.$inferInsert;
export type BookmarkCategory = typeof bookmarkCategoriesTable.$inferSelect;
export type NewBookmarkCategory = typeof bookmarkCategoriesTable.$inferInsert;
export type BookmarkCategoryAssignment =
  typeof bookmarkCategoryAssignmentsTable.$inferSelect;
export type NewBookmarkCategoryAssignment =
  typeof bookmarkCategoryAssignmentsTable.$inferInsert;
export type Rating = typeof ratingsTable.$inferSelect;
export type NewRating = typeof ratingsTable.$inferInsert;
