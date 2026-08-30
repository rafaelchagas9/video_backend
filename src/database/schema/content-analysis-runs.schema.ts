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
import { durableJobsTable } from "./durable-jobs.schema";
import { usersTable } from "./users.schema";
import { videosTable } from "./videos.schema";

const ALLOWED_NUDITY_CATEGORIES_SQL = sql`'["BUTTOCKS_EXPOSED", "FEMALE_BREAST_EXPOSED", "FEMALE_GENITALIA_EXPOSED", "MALE_BREAST_EXPOSED", "ANUS_EXPOSED", "FEET_EXPOSED", "ARMPITS_EXPOSED", "BELLY_EXPOSED", "MALE_GENITALIA_EXPOSED", "ANUS_COVERED", "FEMALE_GENITALIA_COVERED"]'::jsonb`;

export const contentAnalysisRunsTable = pgTable(
  "content_analysis_runs",
  {
    id: serial("id").primaryKey(),
    durableJobId: integer("durable_job_id")
      .notNull()
      .references(() => durableJobsTable.id, { onDelete: "restrict" }),
    videoId: integer("video_id")
      .notNull()
      .references(() => videosTable.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    kind: text("kind").notNull().default("nudity"),
    profile: text("profile").notNull(),
    requestedCategories: jsonb("requested_categories")
      .$type<string[]>()
      .notNull(),

    status: text("status").notNull().default("queued"),
    phase: text("phase").notNull().default("queued"),
    scannedSeconds: real("scanned_seconds").notNull().default(0),
    sourceDurationSeconds: real("source_duration_seconds").notNull(),
    sampledFrames: integer("sampled_frames").notNull().default(0),
    positiveFrames: integer("positive_frames").notNull().default(0),

    sourceFingerprint: text("source_fingerprint").notNull(),
    analyzerRevision: text("analyzer_revision").notNull(),
    modelRevision: text("model_revision").notNull(),
    taxonomyRevision: text("taxonomy_revision").notNull(),
    configRevision: text("config_revision").notNull(),

    idempotencyKey: text("idempotency_key"),
    requestDigest: text("request_digest").notNull(),
    semanticGenerationKey: text("semantic_generation_key").notNull(),

    resultEventCount: integer("result_event_count").notNull().default(0),
    resultBookmarkCount: integer("result_bookmark_count").notNull().default(0),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    retryCount: integer("retry_count").notNull().default(0),

    isPublished: boolean("is_published").notNull().default(false),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    durableJobUnique: uniqueIndex(
      "content_analysis_runs_durable_job_unique"
    ).on(table.durableJobId),
    activeSemanticUnique: uniqueIndex(
      "content_analysis_runs_active_semantic_unique"
    )
      .on(table.semanticGenerationKey)
      .where(sql`${table.status} IN ('queued', 'running', 'retry_wait')`),
    idempotencyUnique: uniqueIndex(
      "content_analysis_runs_user_idempotency_unique"
    )
      .on(table.userId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
    publishedGenerationUnique: uniqueIndex(
      "content_analysis_runs_published_generation_unique"
    )
      .on(table.videoId, table.userId, table.kind)
      .where(sql`${table.isPublished} = true`),
    ownerIdx: index("idx_content_analysis_runs_owner").on(
      table.userId,
      table.id
    ),
    videoHistoryIdx: index("idx_content_analysis_runs_video_history").on(
      table.videoId,
      table.userId,
      table.kind,
      table.createdAt
    ),
    statusIdx: index("idx_content_analysis_runs_status").on(
      table.status,
      table.updatedAt
    ),
    kindCheck: check(
      "content_analysis_runs_kind_check",
      sql`${table.kind} = 'nudity'`
    ),
    profileCheck: check(
      "content_analysis_runs_profile_check",
      sql`${table.profile} IN ('fast', 'balanced', 'thorough')`
    ),
    categoriesCheck: check(
      "content_analysis_runs_categories_check",
      sql`jsonb_typeof(${table.requestedCategories}) = 'array' AND jsonb_array_length(${table.requestedCategories}) BETWEEN 1 AND 11 AND ${table.requestedCategories} <@ ${ALLOWED_NUDITY_CATEGORIES_SQL}`
    ),
    statusCheck: check(
      "content_analysis_runs_status_check",
      sql`${table.status} IN ('queued', 'running', 'retry_wait', 'completed', 'failed', 'cancelled')`
    ),
    phaseCheck: check(
      "content_analysis_runs_phase_check",
      sql`${table.phase} IN ('queued', 'extracting', 'analyzing', 'refining', 'condensing', 'publishing', 'completed', 'failed', 'cancelled')`
    ),
    stateCheck: check(
      "content_analysis_runs_state_check",
      sql`(${table.status} = 'queued' AND ${table.phase} = 'queued') OR (${table.status} IN ('running', 'retry_wait') AND ${table.phase} IN ('queued', 'extracting', 'analyzing', 'refining', 'condensing', 'publishing')) OR (${table.status} = 'completed' AND ${table.phase} = 'completed') OR (${table.status} = 'failed' AND ${table.phase} = 'failed') OR (${table.status} = 'cancelled' AND ${table.phase} = 'cancelled')`
    ),
    progressCheck: check(
      "content_analysis_runs_progress_check",
      sql`${table.sourceDurationSeconds} > 0 AND ${table.scannedSeconds} >= 0 AND ${table.scannedSeconds} <= ${table.sourceDurationSeconds} AND ${table.sampledFrames} >= 0 AND ${table.positiveFrames} >= 0 AND ${table.positiveFrames} <= ${table.sampledFrames} AND ${table.resultEventCount} >= 0 AND ${table.resultBookmarkCount} >= 0 AND ${table.retryCount} >= 0`
    ),
    revisionCheck: check(
      "content_analysis_runs_revision_check",
      sql`length(${table.sourceFingerprint}) > 0 AND length(${table.analyzerRevision}) > 0 AND length(${table.modelRevision}) > 0 AND length(${table.taxonomyRevision}) > 0 AND length(${table.configRevision}) > 0 AND length(${table.requestDigest}) > 0 AND length(${table.semanticGenerationKey}) > 0`
    ),
    errorCheck: check(
      "content_analysis_runs_error_check",
      sql`(${table.status} IN ('retry_wait', 'failed') AND ${table.errorCode} IS NOT NULL AND ${table.errorMessage} IS NOT NULL) OR (${table.status} NOT IN ('retry_wait', 'failed'))`
    ),
    publicationCheck: check(
      "content_analysis_runs_publication_check",
      sql`(${table.isPublished} = true AND ${table.status} = 'completed' AND ${table.publishedAt} IS NOT NULL) OR (${table.isPublished} = false AND ${table.publishedAt} IS NULL)`
    ),
    terminalTimestampsCheck: check(
      "content_analysis_runs_terminal_timestamps_check",
      sql`(${table.status} = 'cancelled' AND ${table.cancelledAt} IS NOT NULL AND ${table.completedAt} IS NOT NULL) OR (${table.status} IN ('completed', 'failed') AND ${table.cancelledAt} IS NULL AND ${table.completedAt} IS NOT NULL) OR (${table.status} IN ('queued', 'running', 'retry_wait') AND ${table.cancelledAt} IS NULL AND ${table.completedAt} IS NULL)`
    ),
  })
);

export type ContentAnalysisRunRecord =
  typeof contentAnalysisRunsTable.$inferSelect;
export type NewContentAnalysisRunRecord =
  typeof contentAnalysisRunsTable.$inferInsert;
