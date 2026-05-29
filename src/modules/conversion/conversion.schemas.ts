import { z } from "zod";
import { CONVERSION_PRESETS } from "@/config/presets";

const validPresetIds = Object.keys(CONVERSION_PRESETS);

const parseBooleanFromDb = (val: unknown) => {
  if (val === null || val === undefined) {
    return false;
  }
  if (typeof val === "boolean") {
    return val;
  }
  if (val === 1 || val === "1") {
    return true;
  }
  if (val === 0 || val === "0") {
    return false;
  }
  return val;
};

/**
 * Schema for creating a conversion job
 */
export const createConversionJobSchema = z.object({
  preset: z.string().refine((val) => validPresetIds.includes(val), {
    message: `Preset must be one of: ${validPresetIds.join(", ")}`,
  }),
  deleteOriginal: z.boolean().optional(),
});

export type CreateConversionJobRequest = z.infer<
  typeof createConversionJobSchema
>;

/**
 * Schema for conversion job response
 */
export const conversionJobSchema = z.object({
  id: z.number(),
  video_id: z.number(),
  status: z.enum(["pending", "processing", "completed", "failed", "cancelled"]),
  preset: z.string(),
  target_resolution: z.string().nullable(),
  codec: z.string(),
  delete_original: z.preprocess(parseBooleanFromDb, z.boolean()).default(false),
  batch_id: z.string().nullable(),
  output_path: z.string().nullable(),
  output_size_bytes: z.number().nullable(),
  progress_percent: z.number(),
  error_message: z.string().nullable(),
  created_at: z.string(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
});

export type ConversionJobResponse = z.infer<typeof conversionJobSchema>;

/**
 * Schema for preset response
 */
export const presetSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  targetWidth: z.number().nullable(),
  codec: z.string(),
  qp: z.number(),
  audioBitrate: z.string(),
  container: z.string(),
});

export type PresetResponse = z.infer<typeof presetSchema>;

/**
 * Schema for list presets response
 */
export const listPresetsResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(presetSchema),
});

/**
 * Schema for conversion job list response
 */
export const listConversionJobsResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(conversionJobSchema),
});

/**
 * Schema for single conversion job response
 */
export const conversionJobResponseSchema = z.object({
  success: z.literal(true),
  data: conversionJobSchema,
});

/**
 * Route parameter schemas
 */
export const videoIdParamSchema = z.object({
  id: z.string().transform(Number),
});

export const jobIdParamSchema = z.object({
  id: z.string().transform(Number),
});

/**
 * Schema for bulk conversion
 */
export const bulkConversionSchema = z.object({
  videoIds: z.array(z.number()),
  preset: z.string().refine((val) => validPresetIds.includes(val), {
    message: `Preset must be one of: ${validPresetIds.join(", ")}`,
  }),
  deleteOriginal: z.boolean().optional(),
});

export type BulkConversionRequest = z.infer<typeof bulkConversionSchema>;

export const bulkConversionResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    batchId: z.string(),
    jobs: z.array(conversionJobSchema),
  }),
});

/**
 * Schema for active conversion item
 */
export const activeConversionSchema = z.object({
  id: z.number(),
  video_id: z.number(),
  video_title: z.string(),
  preset: z.string(),
  status: z.enum(["pending", "processing"]),
  progress_percent: z.number(),
  started_at: z.string().nullable(),
  created_at: z.string(),
});

/**
 * Schema for list active conversions response
 */
export const listActiveConversionsResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(activeConversionSchema),
});

/**
 * Schema for clear queue response
 */
export const clearQueueResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    pendingCleared: z.number(),
    processingReset: z.number(),
    message: z.string(),
  }),
});

export const conversionQueueStatusSchema = z.object({
  queueLength: z.number(),
  activeJobs: z.number(),
  isProcessing: z.boolean(),
});

export const conversionQueueStatusResponseSchema = z.object({
  success: z.literal(true),
  data: conversionQueueStatusSchema,
});

export const updateConversionJobSchema = z.object({
  status: z.literal("cancelled"),
});

export const conversionHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  videoId: z.coerce.number().int().positive().optional(),
  preset: z.string().optional(),
});

export const conversionHistoryItemSchema = z.object({
  id: z.number(),
  conversion_job_id: z.number().nullable(),
  video_id: z.number().nullable(),
  source_video_deleted: z.boolean(),
  source_file_path: z.string(),
  source_file_name: z.string(),
  output_file_path: z.string(),
  preset: z.string(),
  codec: z.string(),
  target_resolution: z.string().nullable(),
  ffmpeg_command: z.string(),
  original_size_bytes: z.number(),
  output_size_bytes: z.number(),
  size_delta_bytes: z.number(),
  size_change_percent: z.number(),
  conversion_duration_ms: z.number().nullable(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  created_at: z.string(),
});

export const conversionHistoryResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(conversionHistoryItemSchema),
});

export const conversionHistoryOverviewSchema = z.object({
  total_conversions: z.number(),
  total_original_size_bytes: z.number(),
  total_output_size_bytes: z.number(),
  total_size_delta_bytes: z.number(),
  total_saved_bytes: z.number(),
  total_increased_bytes: z.number(),
  saved_count: z.number(),
  increased_count: z.number(),
  unchanged_count: z.number(),
  avg_size_change_percent: z.number(),
  avg_conversion_duration_ms: z.number(),
});

export const conversionHistoryOverviewResponseSchema = z.object({
  success: z.literal(true),
  data: conversionHistoryOverviewSchema,
});
