import { pgTable, serial, text, integer, real, timestamp, index } from 'drizzle-orm/pg-core';

// Storage statistics snapshots (hourly)
export const statsStorageSnapshotsTable = pgTable('stats_storage_snapshots', {
  id: serial('id').primaryKey(),
  totalVideoSizeBytes: integer('total_video_size_bytes').notNull(),
  totalVideoCount: integer('total_video_count').notNull(),
  thumbnailsSizeBytes: integer('thumbnails_size_bytes').default(0).notNull(),
  storyboardsSizeBytes: integer('storyboards_size_bytes').default(0).notNull(),
  profilePicturesSizeBytes: integer('profile_pictures_size_bytes').default(0).notNull(),
  convertedSizeBytes: integer('converted_size_bytes').default(0).notNull(),
  databaseSizeBytes: integer('database_size_bytes').default(0).notNull(),
  directoryBreakdown: text('directory_breakdown'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  createdIdx: index('idx_stats_storage_created').on(table.createdAt),
}));

// Library statistics snapshots (daily)
export const statsLibrarySnapshotsTable = pgTable('stats_library_snapshots', {
  id: serial('id').primaryKey(),
  totalVideoCount: integer('total_video_count').notNull(),
  availableVideoCount: integer('available_video_count').notNull(),
  unavailableVideoCount: integer('unavailable_video_count').notNull(),
  totalSizeBytes: integer('total_size_bytes').notNull(),
  averageSizeBytes: integer('average_size_bytes').notNull(),
  totalDurationSeconds: real('total_duration_seconds').notNull(),
  averageDurationSeconds: real('average_duration_seconds').notNull(),
  resolutionBreakdown: text('resolution_breakdown'),
  codecBreakdown: text('codec_breakdown'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  createdIdx: index('idx_stats_library_created').on(table.createdAt),
}));

// Content organization statistics snapshots (daily)
export const statsContentSnapshotsTable = pgTable('stats_content_snapshots', {
  id: serial('id').primaryKey(),
  videosWithoutTags: integer('videos_without_tags').notNull(),
  videosWithoutCreators: integer('videos_without_creators').notNull(),
  videosWithoutRatings: integer('videos_without_ratings').notNull(),
  videosWithoutThumbnails: integer('videos_without_thumbnails').notNull(),
  videosWithoutStoryboards: integer('videos_without_storyboards').notNull(),
  totalTags: integer('total_tags').notNull(),
  totalCreators: integer('total_creators').notNull(),
  totalStudios: integer('total_studios').notNull(),
  totalPlaylists: integer('total_playlists').notNull(),
  topTags: text('top_tags'),
  topCreators: text('top_creators'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  createdIdx: index('idx_stats_content_created').on(table.createdAt),
}));

// Usage/watch statistics snapshots (daily)
export const statsUsageSnapshotsTable = pgTable('stats_usage_snapshots', {
  id: serial('id').primaryKey(),
  totalWatchTimeSeconds: real('total_watch_time_seconds').notNull(),
  totalPlayCount: integer('total_play_count').notNull(),
  uniqueVideosWatched: integer('unique_videos_watched').notNull(),
  videosNeverWatched: integer('videos_never_watched').notNull(),
  averageCompletionRate: real('average_completion_rate'),
  topWatched: text('top_watched'),
  activityByHour: text('activity_by_hour'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  createdIdx: index('idx_stats_usage_created').on(table.createdAt),
}));

// Inferred types
export type StatsStorageSnapshot = typeof statsStorageSnapshotsTable.$inferSelect;
export type NewStatsStorageSnapshot = typeof statsStorageSnapshotsTable.$inferInsert;
export type StatsLibrarySnapshot = typeof statsLibrarySnapshotsTable.$inferSelect;
export type NewStatsLibrarySnapshot = typeof statsLibrarySnapshotsTable.$inferInsert;
export type StatsContentSnapshot = typeof statsContentSnapshotsTable.$inferSelect;
export type NewStatsContentSnapshot = typeof statsContentSnapshotsTable.$inferInsert;
export type StatsUsageSnapshot = typeof statsUsageSnapshotsTable.$inferSelect;
export type NewStatsUsageSnapshot = typeof statsUsageSnapshotsTable.$inferInsert;
