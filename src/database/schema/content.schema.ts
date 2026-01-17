import { pgTable, serial, text, integer, real, timestamp, index, primaryKey, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { usersTable } from './users.schema';
import { videosTable } from './videos.schema';

// Playlists table
export const playlistsTable = pgTable('playlists', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Playlist-Video relationship (many-to-many with position)
export const playlistVideosTable = pgTable('playlist_videos', {
  playlistId: integer('playlist_id').notNull().references(() => playlistsTable.id, { onDelete: 'cascade' }),
  videoId: integer('video_id').notNull().references(() => videosTable.id, { onDelete: 'cascade' }),
  position: integer('position').notNull(),
  addedAt: timestamp('added_at').defaultNow().notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.playlistId, table.videoId] }),
  playlistPositionIdx: index('idx_playlist_videos_playlist').on(table.playlistId, table.position),
}));

// Favorites table
export const favoritesTable = pgTable('favorites', {
  userId: integer('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  videoId: integer('video_id').notNull().references(() => videosTable.id, { onDelete: 'cascade' }),
  addedAt: timestamp('added_at').defaultNow().notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.userId, table.videoId] }),
  userIdx: index('idx_favorites_user').on(table.userId),
}));

// Bookmarks table
export const bookmarksTable = pgTable('bookmarks', {
  id: serial('id').primaryKey(),
  videoId: integer('video_id').notNull().references(() => videosTable.id, { onDelete: 'cascade' }),
  userId: integer('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  timestampSeconds: real('timestamp_seconds').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  videoTimestampIdx: index('idx_bookmarks_video').on(table.videoId, table.timestampSeconds),
  userIdx: index('idx_bookmarks_user').on(table.userId),
}));

// Ratings table
export const ratingsTable = pgTable('ratings', {
  id: serial('id').primaryKey(),
  videoId: integer('video_id').notNull().references(() => videosTable.id, { onDelete: 'cascade' }),
  rating: integer('rating').notNull(),
  comment: text('comment'),
  ratedAt: timestamp('rated_at').defaultNow().notNull(),
}, (table) => ({
  videoIdx: index('idx_ratings_video').on(table.videoId),
  ratingCheck: check('rating_check', sql`rating >= 1 AND rating <= 5`),
}));

// Inferred types
export type Playlist = typeof playlistsTable.$inferSelect;
export type NewPlaylist = typeof playlistsTable.$inferInsert;
export type PlaylistVideo = typeof playlistVideosTable.$inferSelect;
export type NewPlaylistVideo = typeof playlistVideosTable.$inferInsert;
export type Favorite = typeof favoritesTable.$inferSelect;
export type NewFavorite = typeof favoritesTable.$inferInsert;
export type Bookmark = typeof bookmarksTable.$inferSelect;
export type NewBookmark = typeof bookmarksTable.$inferInsert;
export type Rating = typeof ratingsTable.$inferSelect;
export type NewRating = typeof ratingsTable.$inferInsert;
