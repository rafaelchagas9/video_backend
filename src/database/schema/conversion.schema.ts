import { pgTable, serial, text, integer, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { videosTable } from './videos.schema';

// Conversion jobs table
export const conversionJobsTable = pgTable('conversion_jobs', {
  id: serial('id').primaryKey(),
  videoId: integer('video_id').notNull().references(() => videosTable.id, { onDelete: 'cascade' }),
  status: text('status').notNull(), // pending, processing, completed, failed, cancelled
  preset: text('preset').notNull(),
  targetResolution: text('target_resolution'),
  codec: text('codec').notNull(),
  outputPath: text('output_path'),
  outputSizeBytes: integer('output_size_bytes'),
  progressPercent: integer('progress_percent').default(0).notNull(),
  errorMessage: text('error_message'),

  // Configuration
  deleteOriginal: boolean('delete_original').default(false).notNull(),
  batchId: text('batch_id'),

  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  videoIdx: index('idx_conversion_jobs_video').on(table.videoId),
  statusIdx: index('idx_conversion_jobs_status').on(table.status),
  batchIdx: index('idx_conversion_jobs_batch').on(table.batchId),
}));

// Inferred types
export type ConversionJob = typeof conversionJobsTable.$inferSelect;
export type NewConversionJob = typeof conversionJobsTable.$inferInsert;
