/**
 * Face Recognition Validation Schemas
 * Zod schemas for request/response validation
 */

import { z } from 'zod';

/**
 * Add creator face embedding schema
 */
export const addCreatorEmbeddingSchema = z.object({
  creator_id: z.number().int().positive(),
  source_type: z.enum(['manual_upload', 'video_detection', 'profile_picture']),
  source_video_id: z.number().int().positive().optional(),
  source_timestamp_seconds: z.number().nonnegative().optional(),
  is_primary: z.boolean().optional(),
});

export type AddCreatorEmbeddingInput = z.infer<typeof addCreatorEmbeddingSchema>;

/**
 * Set primary embedding schema
 */
export const setPrimaryEmbeddingSchema = z.object({
  embedding_id: z.number().int().positive(),
});

export type SetPrimaryEmbeddingInput = z.infer<typeof setPrimaryEmbeddingSchema>;

/**
 * Confirm face match schema
 */
export const confirmFaceMatchSchema = z.object({
  detection_id: z.number().int().positive(),
  creator_id: z.number().int().positive(),
});

export type ConfirmFaceMatchInput = z.infer<typeof confirmFaceMatchSchema>;

/**
 * Reject face match schema
 */
export const rejectFaceMatchSchema = z.object({
  detection_id: z.number().int().positive(),
});

export type RejectFaceMatchInput = z.infer<typeof rejectFaceMatchSchema>;

/**
 * Search by face schema
 */
export const searchByFaceSchema = z.object({
  limit: z.coerce.number().int().positive().max(100).optional(),
  threshold: z.coerce.number().min(0).max(1).optional(),
});

export type SearchByFaceInput = z.infer<typeof searchByFaceSchema>;

/**
 * Trigger face extraction schema
 */
export const triggerFaceExtractionSchema = z.object({
  video_id: z.number().int().positive(),
});

export type TriggerFaceExtractionInput = z.infer<typeof triggerFaceExtractionSchema>;

/**
 * Get videos by face schema
 */
export const getVideosByFaceSchema = z.object({
  min_confidence: z.coerce.number().min(0).max(1).optional(),
});

export type GetVideosByFaceInput = z.infer<typeof getVideosByFaceSchema>;
