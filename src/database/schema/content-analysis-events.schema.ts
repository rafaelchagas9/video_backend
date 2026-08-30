import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { bookmarksTable } from "./content.schema";
import { contentAnalysisRunsTable } from "./content-analysis-runs.schema";

export interface ContentAnalysisCategorySummaryRecord {
  category: string;
  count: number;
  maxScore: number;
  meanScore: number;
  providerLabel?: string;
}

export const contentAnalysisEventsTable = pgTable(
  "content_analysis_events",
  {
    id: serial("id").primaryKey(),
    runId: integer("run_id")
      .notNull()
      .references(() => contentAnalysisRunsTable.id, { onDelete: "cascade" }),
    generationKey: text("generation_key").notNull(),
    startSeconds: real("start_seconds").notNull(),
    peakSeconds: real("peak_seconds").notNull(),
    endSeconds: real("end_seconds").notNull(),
    categorySummary: jsonb("category_summary")
      .$type<ContentAnalysisCategorySummaryRecord[]>()
      .notNull(),
    publishedBookmarkId: integer("published_bookmark_id").references(
      () => bookmarksTable.id,
      { onDelete: "set null" }
    ),
    isPublished: boolean("is_published").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    runGenerationUnique: uniqueIndex(
      "content_analysis_events_run_generation_unique"
    ).on(table.runId, table.generationKey),
    publishedBookmarkUnique: uniqueIndex(
      "content_analysis_events_published_bookmark_unique"
    )
      .on(table.publishedBookmarkId)
      .where(sql`${table.publishedBookmarkId} IS NOT NULL`),
    runTimelineIdx: index("idx_content_analysis_events_run_timeline").on(
      table.runId,
      table.startSeconds,
      table.id
    ),
    intervalCheck: check(
      "content_analysis_events_interval_check",
      sql`${table.startSeconds} >= 0 AND ${table.startSeconds} <= ${table.peakSeconds} AND ${table.peakSeconds} <= ${table.endSeconds}`
    ),
    categoriesCheck: check(
      "content_analysis_events_categories_check",
      sql`jsonb_typeof(${table.categorySummary}) = 'array' AND jsonb_array_length(${table.categorySummary}) > 0`
    ),
    generationKeyCheck: check(
      "content_analysis_events_generation_key_check",
      sql`length(${table.generationKey}) > 0`
    ),
    publicationCheck: check(
      "content_analysis_events_publication_check",
      sql`${table.isPublished} = false OR ${table.publishedBookmarkId} IS NOT NULL`
    ),
  })
);

export type ContentAnalysisEventRecord =
  typeof contentAnalysisEventsTable.$inferSelect;
export type NewContentAnalysisEventRecord =
  typeof contentAnalysisEventsTable.$inferInsert;
