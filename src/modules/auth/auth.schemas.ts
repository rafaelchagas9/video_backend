import { z } from "zod";

// Request schemas
export const registerBodySchema = z.object({
  username: z
    .string()
    .min(3, "Username must be at least 3 characters")
    .max(50, "Username must be at most 50 characters"),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(100, "Password must be at most 100 characters"),
});

export const loginBodySchema = z.object({
  username: z.string().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
});

// Response schemas
const userSchema = z.object({
  id: z.number(),
  username: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

const errorSchema = z.object({
  message: z.string(),
  statusCode: z.number(),
});

export const authSuccessResponseSchema = z.object({
  success: z.literal(true),
  data: userSchema,
  message: z.string().optional(),
});

export const meResponseSchema = z.object({
  success: z.literal(true),
  data: userSchema,
});

export const logoutResponseSchema = z.object({
  success: z.literal(true),
  message: z.string(),
});

export const errorResponseSchema = z.object({
  success: z.literal(false),
  error: errorSchema,
});

// Type exports
export type RegisterBody = z.infer<typeof registerBodySchema>;
export type LoginBody = z.infer<typeof loginBodySchema>;
