import {
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./users.schema";
import { videosTable } from "./videos.schema";

export const cleanupReviewsTable = pgTable(
  "cleanup_reviews",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    videoId: integer("video_id")
      .notNull()
      .references(() => videosTable.id, { onDelete: "cascade" }),
    disposition: text("disposition").notNull(),
    revision: integer("revision").default(1).notNull(),
    firstReviewedAt: timestamp("first_reviewed_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.videoId] }),
    userDispositionIdx: index("idx_cleanup_reviews_user_disposition").on(
      table.userId,
      table.disposition,
      table.updatedAt
    ),
    dispositionCheck: check(
      "cleanup_reviews_disposition_check",
      sql`${table.disposition} IN ('keep', 'delete', 'later')`
    ),
  })
);

export type CleanupReview = typeof cleanupReviewsTable.$inferSelect;
export type NewCleanupReview = typeof cleanupReviewsTable.$inferInsert;
