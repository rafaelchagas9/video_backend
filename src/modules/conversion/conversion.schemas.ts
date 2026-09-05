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

const commaSeparatedList = z
  .string()
  .transform((value) =>
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
  )
  .pipe(z.array(z.string()).max(20));

export const conversionHistorySortFieldSchema = z.enum([
  "created_at",
  "completed_at",
  "size_change_percent",
  "size_delta_bytes",
  "original_size_bytes",
  "output_size_bytes",
  "conversion_duration_ms",
  "source_bitrate",
  "duration_seconds",
]);

export const conversionOutcomeSchema = z.enum([
  "saved",
  "increased",
  "unchanged",
]);

export const conversionResolutionBucketSchema = z.enum([
  "4k",
  "1440p",
  "1080p",
  "720p",
  "sd",
]);

const conversionHistoryFilterShape = {
  videoId: z.coerce.number().int().positive().optional(),
  preset: z.string().optional(),
  presets: commaSeparatedList.optional(),
  sourceCodec: z.string().optional(),
  resolution: conversionResolutionBucketSchema.optional(),
  outcome: conversionOutcomeSchema.optional(),
  search: z.string().min(1).max(200).optional(),
  createdAfter: z.string().datetime().optional(),
  createdBefore: z.string().datetime().optional(),
  minSizeChangePercent: z.coerce.number().min(-100).max(1000).optional(),
  maxSizeChangePercent: z.coerce.number().min(-100).max(1000).optional(),
  minSourceBitrate: z.coerce.number().int().min(0).optional(),
  maxSourceBitrate: z.coerce.number().int().min(0).optional(),
};

export const conversionHistoryQuerySchema = z.object({
  ...conversionHistoryFilterShape,
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  sortBy: conversionHistorySortFieldSchema.optional(),
  sortDir: z.enum(["asc", "desc"]).optional(),
});

export const conversionHistoryOverviewQuerySchema = z.object(
  conversionHistoryFilterShape
);

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
  duration_seconds: z.number().nullable(),
  source_width: z.number().nullable(),
  source_height: z.number().nullable(),
  source_fps: z.number().nullable(),
  source_codec: z.string().nullable(),
  source_audio_codec: z.string().nullable(),
  source_bitrate: z.number().nullable(),
  output_width: z.number().nullable(),
  output_height: z.number().nullable(),
  output_fps: z.number().nullable(),
  output_codec: z.string().nullable(),
  output_audio_codec: z.string().nullable(),
  output_bitrate: z.number().nullable(),
  profile_version: z.number().nullable(),
  planned_video_bitrate: z.number().nullable(),
  planned_max_bitrate: z.number().nullable(),
  planned_qp: z.number().nullable(),
  effective_resolution: z.string().nullable(),
  encoding_mode: z.enum(["hw", "sw_decode", "full_sw"]).nullable(),
  encode_speed_ratio: z.number().nullable(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  created_at: z.string(),
});

export const conversionHistoryResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(conversionHistoryItemSchema),
  meta: z.object({
    total: z.number(),
    limit: z.number(),
    offset: z.number(),
  }),
});

const conversionInsightGroupSchema = z.object({
  key: z.string(),
  label: z.string(),
  conversions: z.number(),
  total_original_size_bytes: z.number(),
  total_output_size_bytes: z.number(),
  total_saved_bytes: z.number(),
  total_increased_bytes: z.number(),
  increased_count: z.number(),
  avg_size_change_percent: z.number(),
  median_size_change_percent: z.number(),
  avg_source_bitrate: z.number().nullable(),
  avg_output_bitrate: z.number().nullable(),
  avg_conversion_duration_ms: z.number().nullable(),
  avg_encode_speed_ratio: z.number().nullable(),
});

const conversionInsightExtremeSchema = z.object({
  id: z.number(),
  preset: z.string(),
  profile_version: z.number().nullable(),
  effective_resolution: z.string().nullable(),
  source_bitrate: z.number().nullable(),
  output_bitrate: z.number().nullable(),
  original_size_bytes: z.number(),
  output_size_bytes: z.number(),
  size_delta_bytes: z.number(),
  size_change_percent: z.number(),
  conversion_duration_ms: z.number().nullable(),
  created_at: z.string(),
});

export const conversionInsightsSchema = z.object({
  coverage: z.object({
    total_conversions: z.number(),
    analyzed: z.number(),
    with_duration: z.number(),
    with_source_bitrate: z.number(),
    with_source_resolution: z.number(),
    with_source_codec: z.number(),
  }),
  by_preset: z.array(conversionInsightGroupSchema),
  by_source_bitrate: z.array(conversionInsightGroupSchema),
  by_source_resolution: z.array(conversionInsightGroupSchema),
  by_source_codec: z.array(conversionInsightGroupSchema),
  by_source_fps: z.array(conversionInsightGroupSchema),
  by_month: z.array(
    z.object({
      period: z.string(),
      conversions: z.number(),
      total_original_size_bytes: z.number(),
      total_output_size_bytes: z.number(),
      total_saved_bytes: z.number(),
      avg_size_change_percent: z.number(),
    })
  ),
  break_even: z.array(
    z.object({
      resolution_key: z.string(),
      resolution_label: z.string(),
      typical_output_bitrate: z.number().nullable(),
      crossover_bitrate: z.number().nullable(),
      below_count: z.number(),
      below_avg_size_change_percent: z.number().nullable(),
      below_wasted_bytes: z.number(),
      above_count: z.number(),
      above_avg_size_change_percent: z.number().nullable(),
      above_saved_bytes: z.number(),
    })
  ),
  best: z.array(conversionInsightExtremeSchema),
  worst: z.array(conversionInsightExtremeSchema),
  recommendations: z.array(
    z.object({
      id: z.string(),
      severity: z.enum(["critical", "warning", "info"]),
      title: z.string(),
      detail: z.string(),
      metric: z.string().nullable(),
    })
  ),
});

export const conversionInsightsResponseSchema = z.object({
  success: z.literal(true),
  data: conversionInsightsSchema,
});

export const conversionHistoryFacetsResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    presets: z.array(z.string()),
    source_codecs: z.array(z.string()),
  }),
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
export const conversionPreflightSchema = z.object({
  video_id: z.number(),
  preset: z.string(),
  source_size_bytes: z.number(),
  target_resolution: z.string(),
  estimated_output_bytes: z.number().nullable(),
  estimated_savings_bytes: z.number().nullable(),
  estimated_savings_percent: z.number().nullable(),
  confidence: z.enum(["high", "medium", "low"]),
  historical_sample_count: z.number().int(),
  prediction_error_percent: z.number().nullable(),
  recommendation: z.enum(["recommended", "marginal", "unlikely", "unknown"]),
  reason: z.enum(["insufficient_metadata", "little_or_no_savings"]).nullable(),
});
