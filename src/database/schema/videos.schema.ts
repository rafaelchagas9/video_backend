import { pgTable, serial, text, integer, real, boolean, timestamp, index, primaryKey } from 'drizzle-orm/pg-core';
import { watchedDirectoriesTable } from './directories.schema';
import { usersTable } from './users.schema';

// Videos table (core media information)
export const videosTable = pgTable('videos', {
  id: serial('id').primaryKey(),
  filePath: text('file_path').notNull().unique(),
  fileName: text('file_name').notNull(),
  directoryId: integer('directory_id').notNull().references(() => watchedDirectoriesTable.id, { onDelete: 'cascade' }),

  // File metadata
  fileSizeBytes: integer('file_size_bytes').notNull(),
  fileHash: text('file_hash'),

  // Video metadata (extracted)
  durationSeconds: real('duration_seconds'),
  width: integer('width'),
  height: integer('height'),
  codec: text('codec'),
  bitrate: integer('bitrate'),
  fps: real('fps'),
  audioCodec: text('audio_codec'),

  // User-editable metadata
  title: text('title'),
  description: text('description'),
  themes: text('themes'),

  // Status tracking
  isAvailable: boolean('is_available').default(true).notNull(),
  lastVerifiedAt: timestamp('last_verified_at'),
  indexedAt: timestamp('indexed_at').defaultNow().notNull(),

  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  directoryIdx: index('idx_videos_directory').on(table.directoryId),
  filePathIdx: index('idx_videos_file_path').on(table.filePath),
  fileHashIdx: index('idx_videos_file_hash').on(table.fileHash),
  isAvailableIdx: index('idx_videos_is_available').on(table.isAvailable),
}));

// Video statistics (per-user watch data)
export const videoStatsTable = pgTable('video_stats', {
  userId: integer('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  videoId: integer('video_id').notNull().references(() => videosTable.id, { onDelete: 'cascade' }),
  playCount: integer('play_count').default(0).notNull(),
  totalWatchSeconds: real('total_watch_seconds').default(0).notNull(),
  sessionWatchSeconds: real('session_watch_seconds').default(0).notNull(),
  sessionPlayCounted: boolean('session_play_counted').default(false).notNull(),
  lastPositionSeconds: real('last_position_seconds'),
  lastPlayedAt: timestamp('last_played_at'),
  lastWatchAt: timestamp('last_watch_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.userId, table.videoId] }),
  videoIdx: index('idx_video_stats_video').on(table.videoId),
  userIdx: index('idx_video_stats_user').on(table.userId),
  lastPlayedIdx: index('idx_video_stats_last_played').on(table.lastPlayedAt),
}));

// Custom metadata (arbitrary key-value pairs)
export const videoMetadataTable = pgTable('video_metadata', {
  id: serial('id').primaryKey(),
  videoId: integer('video_id').notNull().references(() => videosTable.id, { onDelete: 'cascade' }),
  key: text('key').notNull(),
  value: text('value').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  videoIdx: index('idx_video_metadata_video').on(table.videoId),
  keyIdx: index('idx_video_metadata_key').on(table.key),
}));

// Inferred types
export type Video = typeof videosTable.$inferSelect;
export type NewVideo = typeof videosTable.$inferInsert;
export type VideoStats = typeof videoStatsTable.$inferSelect;
export type NewVideoStats = typeof videoStatsTable.$inferInsert;
export type VideoMetadata = typeof videoMetadataTable.$inferSelect;
export type NewVideoMetadata = typeof videoMetadataTable.$inferInsert;
