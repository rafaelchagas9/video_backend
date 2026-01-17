import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

// App settings table
export const appSettingsTable = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Inferred types
export type AppSetting = typeof appSettingsTable.$inferSelect;
export type NewAppSetting = typeof appSettingsTable.$inferInsert;
