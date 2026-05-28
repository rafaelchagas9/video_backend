import { z } from "zod";

export const registerBodySchema = z.object({
  email: z.email("A valid email is required"),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(100, "Password must be at most 100 characters"),
  name: z
    .string()
    .trim()
    .min(1, "Name cannot be empty")
    .max(100, "Name must be at most 100 characters")
    .optional(),
});

export const loginBodySchema = z.object({
  email: z.email("A valid email is required").optional(),
  username: z.string().trim().min(1, "Username is required").optional(),
  password: z.string().min(1, "Password is required"),
}).refine((data) => Boolean(data.email || data.username), {
  message: "Either email or username is required",
  path: ["email"],
});

const userSchema = z.object({
  id: z.number(),
  name: z.string(),
  email: z.string().email(),
  email_verified: z.boolean(),
  image: z.string().nullable(),
  username: z.string().nullable(),
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

export type RegisterBody = z.infer<typeof registerBodySchema>;
export type LoginBody = z.infer<typeof loginBodySchema>;
