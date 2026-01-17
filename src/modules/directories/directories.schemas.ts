import { z } from "zod";

// Re-export from types for consistency
export {
  createDirectorySchema,
  updateDirectorySchema,
} from "./directories.types";

// Request schemas
export const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

// Response schemas
const directorySchema = z.object({
  id: z.number(),
  path: z.string(),
  is_active: z.boolean(),
  auto_scan: z.boolean(),
  scan_interval_minutes: z.number(),
  last_scan_at: z.string().nullable(),
  added_at: z.string(),
  updated_at: z.string(),
});

const directoryStatsSchema = z.object({
  directory_id: z.number(),
  total_videos: z.number(),
  total_size_bytes: z.number(),
  available_videos: z.number(),
  unavailable_videos: z.number(),
});

const errorSchema = z.object({
  message: z.string(),
  statusCode: z.number(),
});

export const directoryResponseSchema = z.object({
  success: z.literal(true),
  data: directorySchema,
  message: z.string().optional(),
});

export const directoryListResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(directorySchema),
});

export const directoryStatsResponseSchema = z.object({
  success: z.literal(true),
  data: directoryStatsSchema,
});

export const messageResponseSchema = z.object({
  success: z.literal(true),
  message: z.string(),
});

export const errorResponseSchema = z.object({
  success: z.literal(false),
  error: errorSchema,
});
