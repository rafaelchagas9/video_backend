import { pgTable, serial, text, integer, real, timestamp, index } from 'drizzle-orm/pg-core';
import { videosTable } from './videos.schema';

// Thumbnails table
export const thumbnailsTable = pgTable('thumbnails', {
  id: serial('id').primaryKey(),
  videoId: integer('video_id').notNull().unique().references(() => videosTable.id, { onDelete: 'cascade' }),
  filePath: text('file_path').notNull(),
  fileSizeBytes: integer('file_size_bytes'),
  timestampSeconds: real('timestamp_seconds').default(5.0).notNull(),
  width: integer('width'),
  height: integer('height'),
  generatedAt: timestamp('generated_at').defaultNow().notNull(),
}, (table) => ({
  videoIdx: index('idx_thumbnails_video').on(table.videoId),
}));

// Storyboards table (Vidstack slider thumbnails)
export const storyboardsTable = pgTable('storyboards', {
  id: serial('id').primaryKey(),
  videoId: integer('video_id').notNull().unique().references(() => videosTable.id, { onDelete: 'cascade' }),
  spritePath: text('sprite_path').notNull(),
  vttPath: text('vtt_path').notNull(),
  tileWidth: integer('tile_width').notNull(),
  tileHeight: integer('tile_height').notNull(),
  tileCount: integer('tile_count').notNull(),
  intervalSeconds: real('interval_seconds').notNull(),
  spriteSizeBytes: integer('sprite_size_bytes'),
  generatedAt: timestamp('generated_at').defaultNow().notNull(),
}, (table) => ({
  videoIdx: index('idx_storyboards_video').on(table.videoId),
}));

// Inferred types
export type Thumbnail = typeof thumbnailsTable.$inferSelect;
export type NewThumbnail = typeof thumbnailsTable.$inferInsert;
export type Storyboard = typeof storyboardsTable.$inferSelect;
export type NewStoryboard = typeof storyboardsTable.$inferInsert;
