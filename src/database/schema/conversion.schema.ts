import {
  pgTable,
  serial,
  text,
  integer,
  bigint,
  boolean,
  timestamp,
  index,
  real,
} from "drizzle-orm/pg-core";
import { videosTable } from "./videos.schema";

// Conversion jobs table
export const conversionJobsTable = pgTable(
  "conversion_jobs",
  {
    id: serial("id").primaryKey(),
    videoId: integer("video_id")
      .notNull()
      .references(() => videosTable.id, { onDelete: "cascade" }),
    status: text("status").notNull(), // pending, processing, completed, failed, cancelled
    preset: text("preset").notNull(),
    targetResolution: text("target_resolution"),
    codec: text("codec").notNull(),
    outputPath: text("output_path"),
    outputSizeBytes: bigint("output_size_bytes", { mode: "number" }),
    progressPercent: integer("progress_percent").default(0).notNull(),
    errorMessage: text("error_message"),
    ffmpegOutput: text("ffmpeg_output"),

    // Configuration
    deleteOriginal: boolean("delete_original").default(false).notNull(),
    batchId: text("batch_id"),

    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    videoPresetStatusIdx: index("idx_conversion_jobs_video_preset_status").on(
      table.videoId,
      table.preset,
      table.status,
    ),
    batchIdx: index("idx_conversion_jobs_batch").on(table.batchId),
  }),
);

// Completed conversions history table for long-term storage insights
export const conversionHistoryTable = pgTable(
  "conversion_history",
  {
    id: serial("id").primaryKey(),
    conversionJobId: integer("conversion_job_id").references(
      () => conversionJobsTable.id,
      { onDelete: "set null" },
    ),
    videoId: integer("video_id").references(() => videosTable.id, {
      onDelete: "set null",
    }),

    sourceFilePath: text("source_file_path").notNull(),
    sourceFileName: text("source_file_name").notNull(),
    outputFilePath: text("output_file_path").notNull(),

    preset: text("preset").notNull(),
    codec: text("codec").notNull(),
    targetResolution: text("target_resolution"),
    ffmpegCommand: text("ffmpeg_command").notNull(),

    originalSizeBytes: bigint("original_size_bytes", {
      mode: "number",
    }).notNull(),
    outputSizeBytes: bigint("output_size_bytes", { mode: "number" }).notNull(),
    sizeDeltaBytes: bigint("size_delta_bytes", { mode: "number" }).notNull(),
    sizeChangePercent: real("size_change_percent").notNull(),

    // Media metadata captured at conversion time. Nullable because rows written
    // before these columns existed are backfilled on a best-effort basis.
    durationSeconds: real("duration_seconds"),

    sourceWidth: integer("source_width"),
    sourceHeight: integer("source_height"),
    sourceFps: real("source_fps"),
    sourceCodec: text("source_codec"),
    sourceAudioCodec: text("source_audio_codec"),
    sourceBitrate: integer("source_bitrate"),

    outputWidth: integer("output_width"),
    outputHeight: integer("output_height"),
    outputFps: real("output_fps"),
    outputCodec: text("output_codec"),
    outputAudioCodec: text("output_audio_codec"),
    outputBitrate: integer("output_bitrate"),

    // Normalized encoder plan. Raw FFmpeg commands contain file paths and are
    // not suitable as the analytics contract.
    profileVersion: integer("profile_version"),
    plannedVideoBitrate: integer("planned_video_bitrate"),
    plannedMaxBitrate: integer("planned_max_bitrate"),
    plannedQp: integer("planned_qp"),
    effectiveResolution: text("effective_resolution"),
    encodingMode: text("encoding_mode"),

    conversionDurationMs: integer("conversion_duration_ms"),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    createdAtIdx: index("idx_conversion_history_created_at").on(
      table.createdAt,
    ),
    presetIdx: index("idx_conversion_history_preset").on(table.preset),
    videoIdx: index("idx_conversion_history_video").on(table.videoId),
    jobIdx: index("idx_conversion_history_job").on(table.conversionJobId),
    sizeChangeIdx: index("idx_conversion_history_size_change").on(
      table.sizeChangePercent,
    ),
    sourceCodecIdx: index("idx_conversion_history_source_codec").on(
      table.sourceCodec,
    ),
  }),
);

// Inferred types
export type ConversionJob = typeof conversionJobsTable.$inferSelect;
export type NewConversionJob = typeof conversionJobsTable.$inferInsert;
export type ConversionHistory = typeof conversionHistoryTable.$inferSelect;
export type NewConversionHistory = typeof conversionHistoryTable.$inferInsert;
