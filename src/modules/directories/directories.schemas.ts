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

export const scanIdParamSchema = idParamSchema.extend({
  scanId: z.coerce.number().int().positive(),
});

export const scanPaginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
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

export const scanRunSchema = z.object({
  id: z.number(),
  directory_id: z.number(),
  status: z.enum(["running", "completed"]),
  files_found: z.number(),
  files_added: z.number(),
  files_updated: z.number(),
  files_removed: z.number(),
  error_count: z.number(),
  error_summaries: z.array(z.string()).max(5),
  started_at: z.string(),
  completed_at: z.string().nullable(),
});

const paginationSchema = z.object({
  page: z.number(),
  limit: z.number(),
  total: z.number(),
  totalPages: z.number(),
});

export const scanRunResponseSchema = z.object({
  success: z.literal(true),
  data: scanRunSchema,
});

export const scanStartedResponseSchema = scanRunResponseSchema.meta({
  headers: {
    Location: {
      description: "Canonical URL of the accepted scan-run resource",
      type: "string",
    },
  },
});

export const scanRunListResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(scanRunSchema),
  pagination: paginationSchema,
});

export const schedulerStatusResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    is_running: z.boolean(),
    scheduled_directories: z.number(),
    schedules: z.array(
      z.object({
        directory_id: z.number(),
        interval_minutes: z.number(),
      })
    ),
    system_tasks: z.array(
      z.object({
        name: z.string(),
        cron_expression: z.string(),
      })
    ),
  }),
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
