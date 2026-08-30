import { sql } from "drizzle-orm";
import {
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
import { contentAnalysisRunsTable } from "./content-analysis-runs.schema";

/**
 * Canonical, media-free observation persisted after one source chunk.
 * Bounding boxes and temporary frame paths deliberately never enter storage.
 */
export interface ContentAnalysisObservationRecord {
  timestampSeconds: number;
  category: string;
  score: number;
  providerLabel?: string;
}

export const contentAnalysisObservationChunksTable = pgTable(
  "content_analysis_observation_chunks",
  {
    id: serial("id").primaryKey(),
    runId: integer("run_id")
      .notNull()
      .references(() => contentAnalysisRunsTable.id, { onDelete: "cascade" }),
    phase: text("phase").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    startSeconds: real("start_seconds").notNull(),
    endSeconds: real("end_seconds").notNull(),
    sampledFrames: integer("sampled_frames").notNull(),
    positiveFrames: integer("positive_frames").notNull(),
    findings: jsonb("findings")
      .$type<ContentAnalysisObservationRecord[]>()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    runPhaseChunkUnique: uniqueIndex(
      "content_analysis_observation_chunks_run_phase_chunk_unique"
    ).on(table.runId, table.phase, table.chunkIndex),
    runTimelineIdx: index(
      "idx_content_analysis_observation_chunks_run_timeline"
    ).on(table.runId, table.phase, table.startSeconds, table.chunkIndex),
    phaseCheck: check(
      "content_analysis_observation_chunks_phase_check",
      sql`${table.phase} IN ('coarse', 'refining')`
    ),
    intervalCheck: check(
      "content_analysis_observation_chunks_interval_check",
      sql`${table.chunkIndex} >= 0 AND ${table.startSeconds} >= 0 AND ${table.endSeconds} >= ${table.startSeconds}`
    ),
    countsCheck: check(
      "content_analysis_observation_chunks_counts_check",
      sql`${table.sampledFrames} >= 0 AND ${table.positiveFrames} >= 0 AND ${table.positiveFrames} <= ${table.sampledFrames}`
    ),
    findingsCheck: check(
      "content_analysis_observation_chunks_findings_check",
      sql`jsonb_typeof(${table.findings}) = 'array'`
    ),
  })
);

export type ContentAnalysisObservationChunkRecord =
  typeof contentAnalysisObservationChunksTable.$inferSelect;
export type NewContentAnalysisObservationChunkRecord =
  typeof contentAnalysisObservationChunksTable.$inferInsert;
