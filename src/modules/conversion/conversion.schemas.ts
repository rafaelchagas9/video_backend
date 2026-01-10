import { z } from 'zod';
import { CONVERSION_PRESETS } from '@/config/presets';

const validPresetIds = Object.keys(CONVERSION_PRESETS);

/**
 * Schema for creating a conversion job
 */
export const createConversionJobSchema = z.object({
  preset: z.string().refine(
    (val) => validPresetIds.includes(val),
    { message: `Preset must be one of: ${validPresetIds.join(', ')}` }
  ),
});

export type CreateConversionJobRequest = z.infer<typeof createConversionJobSchema>;

/**
 * Schema for conversion job response
 */
export const conversionJobSchema = z.object({
  id: z.number(),
  video_id: z.number(),
  status: z.enum(['pending', 'processing', 'completed', 'failed', 'cancelled']),
  preset: z.string(),
  target_resolution: z.string().nullable(),
  codec: z.string(),
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
