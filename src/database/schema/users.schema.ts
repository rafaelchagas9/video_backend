import { pgTable, serial, text, timestamp, index } from 'drizzle-orm/pg-core';

// Users table (single user system with potential for expansion)
export const usersTable = pgTable('users', {
  id: serial('id').primaryKey(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Sessions table (session-based authentication)
export const sessionsTable = pgTable('sessions', {
  id: text('id').primaryKey(),
  userId: serial('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  userIdx: index('idx_sessions_user').on(table.userId),
  expiresIdx: index('idx_sessions_expires').on(table.expiresAt),
}));

// Inferred types
export type User = typeof usersTable.$inferSelect;
export type NewUser = typeof usersTable.$inferInsert;
export type Session = typeof sessionsTable.$inferSelect;
export type NewSession = typeof sessionsTable.$inferInsert;
