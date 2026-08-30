/**
 * Face Recognition Validation Schemas
 * Zod schemas for request/response validation
 */

import { z } from "zod";

export const faceEmbeddingSourceTypeSchema = z.enum([
  "manual_upload",
  "video_detection",
  "profile_picture",
  "gallery_media",
]);

/**
 * Add creator face embedding schema
 */
export const addCreatorEmbeddingSchema = z.object({
  creator_id: z.number().int().positive(),
  source_type: faceEmbeddingSourceTypeSchema,
  source_video_id: z.number().int().positive().optional(),
  source_timestamp_seconds: z.number().nonnegative().optional(),
  is_primary: z.boolean().optional(),
});

export type AddCreatorEmbeddingInput = z.infer<
  typeof addCreatorEmbeddingSchema
>;

/**
 * Set primary embedding schema
 */
export const setPrimaryEmbeddingSchema = z.object({
  embedding_id: z.number().int().positive(),
});

export type SetPrimaryEmbeddingInput = z.infer<
  typeof setPrimaryEmbeddingSchema
>;

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

export type TriggerFaceExtractionInput = z.infer<
  typeof triggerFaceExtractionSchema
>;

/**
 * Get videos by face schema
 */
export const getVideosByFaceSchema = z.object({
  min_confidence: z.coerce.number().min(0).max(1).optional(),
});

export type GetVideosByFaceInput = z.infer<typeof getVideosByFaceSchema>;

/**
 * Enhanced face detection response schema (frontend-friendly)
 */
export const matchedCreatorSchema = z.object({
  id: z.number(),
  name: z.string(),
  profilePictureUrl: z.string().nullable().optional(),
});

export const faceDetectionResponseSchema = z.object({
  id: z.number(),
  videoId: z.number(),
  timestampSeconds: z.number(),
  frameIndex: z.number().nullable(),
  detectionConfidence: z.number(),
  matchedCreator: matchedCreatorSchema.optional(),
  matchConfidence: z.number().nullable().optional(),
  matchStatus: z.enum(["pending", "confirmed", "rejected", "no_match"]),
  faceImageUrl: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const videoFacesResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(faceDetectionResponseSchema),
});

export const publicCreatorFaceEmbeddingSchema = z.object({
  id: z.number().int().positive(),
  creatorId: z.number().int().positive(),
  sourceType: z.string(),
  sourceVideoId: z.number().int().positive().nullable(),
  sourceTimestampSeconds: z.number().nonnegative().nullable(),
  detScore: z.number().min(0).max(1).nullable(),
  isPrimary: z.boolean(),
  image_url: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const publicCreatorFaceEmbeddingResponseSchema = z.object({
  success: z.literal(true),
  data: publicCreatorFaceEmbeddingSchema,
});

export const publicCreatorFaceEmbeddingsResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(publicCreatorFaceEmbeddingSchema),
});

export const faceHealthResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    status: z.enum(["healthy", "degraded", "unhealthy"]),
    version: z.string().optional(),
    model: z.string().optional(),
    onnx_providers: z.array(z.string()).optional(),
    embedding_dimension: z.number().int().positive().optional(),
    uptime_seconds: z.number().nonnegative().optional(),
  }),
});

export const videosByFaceResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(
    z.object({
      videoId: z.number().int().positive(),
      detectionCount: z.number().int().nonnegative(),
      avgConfidence: z.number().min(0).max(1),
    })
  ),
});

export const faceSearchResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(
    z.object({
      creator_id: z.number().int().positive(),
      creator_name: z.string(),
      similarity: z.number().min(0).max(1),
      reference_embedding_id: z.number().int().positive(),
      reference_source_type: z.string(),
    })
  ),
});

export const faceExtractionJobResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    id: z.number().int().positive(),
    videoId: z.number().int().positive(),
    status: z.enum(["pending", "processing", "completed", "failed", "skipped"]),
    totalFrames: z.number().int().nonnegative().nullable(),
    processedFrames: z.number().int().nonnegative(),
    facesDetected: z.number().int().nonnegative(),
    errorMessage: z.string().nullable(),
    retryCount: z.number().int().nonnegative(),
    startedAt: z.date().nullable(),
    completedAt: z.date().nullable(),
    createdAt: z.date(),
    updatedAt: z.date(),
  }),
});

export type FaceDetectionResponse = z.infer<typeof faceDetectionResponseSchema>;
export type MatchedCreator = z.infer<typeof matchedCreatorSchema>;
