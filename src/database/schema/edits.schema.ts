import {
  pgTable,
  serial,
  text,
  integer,
  json,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { videosTable } from "./videos.schema";

// Edit jobs table
export const editJobsTable = pgTable(
  "edit_jobs",
  {
    id: serial("id").primaryKey(),
    videoId: integer("video_id")
      .notNull()
      .references(() => videosTable.id, { onDelete: "cascade" }),
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
    statusIdx: index("idx_edit_jobs_status").on(table.status),
    outputVideoIdx: index("idx_edit_jobs_output_video").on(table.outputVideoId),
  }),
);

// Inferred types
export type EditJob = typeof editJobsTable.$inferSelect;
export type NewEditJob = typeof editJobsTable.$inferInsert;
