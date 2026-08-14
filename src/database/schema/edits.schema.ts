import {
  pgTable,
  serial,
  text,
  integer,
  json,
  timestamp,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { videosTable } from "./videos.schema";

// Edit jobs table
export const editJobsTable = pgTable(
  "edit_jobs",
  {
    id: serial("id").primaryKey(),
    // Immutable source-id snapshot retained after the source catalog row is deleted.
    videoId: integer("video_id").notNull(),
    // Live FK used only while a job can still read the source file.
    activeVideoId: integer("active_video_id").references(() => videosTable.id, {
      onDelete: "restrict",
    }),
    status: text("status").notNull(), // pending, queued, running, completed, failed, cancelled
    progress: integer("progress").default(0).notNull(),

    // Configuration
    outputConfig: json("output_config").notNull(),
    timelineConfig: json("timeline_config").notNull(),

    // Results
    outputPath: text("output_path"),
    outputVideoId: integer("output_video_id").references(() => videosTable.id, {
      onDelete: "set null",
    }),
    errorMessage: text("error_message"),

    // Timestamps
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    videoIdx: index("idx_edit_jobs_video").on(table.videoId),
    activeVideoIdx: index("idx_edit_jobs_active_video").on(table.activeVideoId),
    statusIdx: index("idx_edit_jobs_status").on(table.status),
    outputVideoIdx: index("idx_edit_jobs_output_video").on(table.outputVideoId),
    activeVideoStatusCheck: check(
      "edit_jobs_active_video_status_check",
      sql`((${table.status} in ('pending', 'queued', 'running')) and ${table.activeVideoId} is not null) or ((${table.status} in ('completed', 'failed', 'cancelled')) and ${table.activeVideoId} is null)`
    ),
  })
);

// Inferred types
export type EditJob = typeof editJobsTable.$inferSelect;
export type NewEditJob = typeof editJobsTable.$inferInsert;
