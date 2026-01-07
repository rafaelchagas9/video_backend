import { z } from "zod";

// Request schemas
export const filenameParamSchema = z.object({
  filename: z.string().min(1, "Filename is required"),
});

// Response schemas
const backupInfoSchema = z.object({
  filename: z.string(),
  path: z.string(),
  sizeBytes: z.number(),
  createdAt: z.string(),
});

const errorSchema = z.object({
  message: z.string(),
  statusCode: z.number(),
});

export const backupCreatedResponseSchema = z.object({
  success: z.literal(true),
  data: backupInfoSchema,
  message: z.string(),
});

export const backupListResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(backupInfoSchema),
});

export const messageResponseSchema = z.object({
  success: z.literal(true),
  message: z.string(),
});

export const errorResponseSchema = z.object({
  success: z.literal(false),
  error: errorSchema,
});

// Type exports
export type FilenameParam = z.infer<typeof filenameParamSchema>;
