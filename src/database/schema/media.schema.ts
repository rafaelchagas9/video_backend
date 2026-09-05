import {
  pgTable,
  serial,
  text,
  integer, bigint,
  real,
  timestamp,
  index,
  jsonb,
  unique,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { videosTable } from './videos.schema';

// Thumbnails table
export const thumbnailsTable = pgTable('thumbnails', {
  id: serial('id').primaryKey(),
  videoId: integer('video_id').notNull().unique().references(() => videosTable.id, { onDelete: 'cascade' }),
  filePath: text('file_path').notNull(),
  fileSizeBytes: bigint('file_size_bytes', { mode: "number" }),
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
  spriteSizeBytes: bigint('sprite_size_bytes', { mode: "number" }),
  generatedAt: timestamp('generated_at').defaultNow().notNull(),
}, (table) => ({
  videoIdx: index('idx_storyboards_video').on(table.videoId),
}));

export const videoArtworkTable = pgTable('video_artwork', {
  id: serial('id').primaryKey(),
  videoId: integer('video_id').notNull().unique().references(() => videosTable.id, { onDelete: 'cascade' }),
  status: text('status').default('absent').notNull(),
  palette: jsonb('palette'),
  error: text('error'),
  request: jsonb('request'),
  generatedAt: timestamp('generated_at'),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  statusIdx: index('idx_video_artwork_status').on(table.status),
  statusCheck: check(
    'video_artwork_status_check',
    sql`${table.status} IN ('ready', 'generating', 'failed', 'absent')`,
  ),
}));

export const artworkAssetsTable = pgTable('artwork_assets', {
  id: serial('id').primaryKey(),
  videoId: integer('video_id').notNull().references(() => videosTable.id, { onDelete: 'cascade' }),
  variant: text('variant').notNull(),
  contentHash: text('content_hash').notNull(),
  filePath: text('file_path').notNull(),
  fileSizeBytes: bigint('file_size_bytes', { mode: "number" }).notNull(),
  width: integer('width').notNull(),
  height: integer('height').notNull(),
  sourceTimestampSeconds: real('source_timestamp_seconds'),
  crop: jsonb('crop'),
  focalPoint: jsonb('focal_point'),
  safeArea: jsonb('safe_area'),
  bottomLuma: real('bottom_luma'),
  thumbhash: text('thumbhash'),
  effects: jsonb('effects').notNull(),
  generatedAt: timestamp('generated_at').defaultNow().notNull(),
}, (table) => ({
  videoIdx: index('idx_artwork_assets_video').on(table.videoId),
  hashIdx: index('idx_artwork_assets_content_hash').on(table.contentHash),
  uniqueVideoVariant: unique('artwork_assets_video_variant_unique').on(table.videoId, table.variant),
  variantCheck: check(
    'artwork_assets_variant_check',
    sql`${table.variant} IN ('card', 'poster', 'square', 'hero', 'title')`,
  ),
}));

// Inferred types
export type Thumbnail = typeof thumbnailsTable.$inferSelect;
export type NewThumbnail = typeof thumbnailsTable.$inferInsert;
export type Storyboard = typeof storyboardsTable.$inferSelect;
export type NewStoryboard = typeof storyboardsTable.$inferInsert;
export type VideoArtworkRecord = typeof videoArtworkTable.$inferSelect;
export type NewVideoArtworkRecord = typeof videoArtworkTable.$inferInsert;
export type ArtworkAssetRecord = typeof artworkAssetsTable.$inferSelect;
export type NewArtworkAssetRecord = typeof artworkAssetsTable.$inferInsert;
