import { pgTable, serial, text, integer, boolean, timestamp, index } from 'drizzle-orm/pg-core';

// Watched directories table
export const watchedDirectoriesTable = pgTable('watched_directories', {
  id: serial('id').primaryKey(),
  path: text('path').notNull().unique(),
  isActive: boolean('is_active').default(true).notNull(),
  autoScan: boolean('auto_scan').default(true).notNull(),
  scanIntervalMinutes: integer('scan_interval_minutes').default(30).notNull(),
  lastScanAt: timestamp('last_scan_at'),
  addedAt: timestamp('added_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Scan logs table
export const scanLogsTable = pgTable('scan_logs', {
  id: serial('id').primaryKey(),
  directoryId: integer('directory_id').notNull().references(() => watchedDirectoriesTable.id, { onDelete: 'cascade' }),
  filesFound: integer('files_found').default(0).notNull(),
  filesAdded: integer('files_added').default(0).notNull(),
  filesUpdated: integer('files_updated').default(0).notNull(),
  filesRemoved: integer('files_removed').default(0).notNull(),
  errors: text('errors'),
  startedAt: timestamp('started_at').notNull(),
  completedAt: timestamp('completed_at'),
}, (table) => ({
  directoryIdx: index('idx_scan_logs_directory').on(table.directoryId),
  startedIdx: index('idx_scan_logs_started').on(table.startedAt),
}));

// Inferred types
export type WatchedDirectory = typeof watchedDirectoriesTable.$inferSelect;
export type NewWatchedDirectory = typeof watchedDirectoriesTable.$inferInsert;
export type ScanLog = typeof scanLogsTable.$inferSelect;
export type NewScanLog = typeof scanLogsTable.$inferInsert;
