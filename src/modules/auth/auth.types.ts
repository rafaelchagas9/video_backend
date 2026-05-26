import { z } from "zod";

export const registerSchema = z.object({
  email: z.email(),
  password: z.string().min(8).max(100),
  name: z.string().trim().min(1).max(100).optional(),
});

export const loginSchema = z.object({
  email: z.email().optional(),
  username: z.string().trim().min(1).optional(),
  password: z.string().min(1),
}).refine((data) => Boolean(data.email || data.username), {
  message: "Either email or username is required",
  path: ["email"],
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;

export interface AuthUser {
  id: number;
  name: string;
  email: string;
  email_verified: boolean;
  image: string | null;
  username: string | null;
  created_at: string;
  updated_at: string;
}

export interface AuthSession {
  id: string;
  token: string;
  user_id: number;
  expires_at: string;
  created_at: string;
  updated_at: string;
  ip_address: string | null;
  user_agent: string | null;
}

export interface AuthSessionData {
  user: AuthUser;
  session: AuthSession;
}
