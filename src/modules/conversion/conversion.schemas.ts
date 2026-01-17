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
