import { pgTable, serial, text, integer, timestamp, index, unique } from 'drizzle-orm/pg-core';
import { usersTable } from './users.schema';
import { videosTable } from './videos.schema';

// Triage progress tracking table
export const triageProgressTable = pgTable('triage_progress', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  filterKey: text('filter_key').notNull(),
  lastVideoId: integer('last_video_id').references(() => videosTable.id, { onDelete: 'set null' }),
  processedCount: integer('processed_count').default(0).notNull(),
  totalCount: integer('total_count'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  userIdx: index('idx_triage_progress_user').on(table.userId),
  filterIdx: index('idx_triage_progress_filter').on(table.userId, table.filterKey),
  uniqueUserFilter: unique('unique_user_filter').on(table.userId, table.filterKey),
}));

// Inferred types
export type TriageProgress = typeof triageProgressTable.$inferSelect;
export type NewTriageProgress = typeof triageProgressTable.$inferInsert;
