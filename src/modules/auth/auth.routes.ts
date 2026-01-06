import type { FastifyInstance } from "fastify";
import { validateSchema } from "@/utils/validation";
import { authService } from "./auth.service";
import { registerSchema, loginSchema } from "./auth.types";
import { authenticateUser } from "./auth.middleware";
import { COOKIE_NAME } from "@/config/constants";
import { env } from "@/config/env";

export async function authRoutes(fastify: FastifyInstance): Promise<void> {
  // Register new user
  fastify.post(
    "/register",
    {
      schema: {
        tags: ["auth"],
      },
    },
    async (request, reply) => {
      const input = validateSchema(registerSchema, request.body);
      const user = await authService.register(input);

      return reply.status(201).send({
        success: true,
        data: user,
        message: "User created successfully",
      });
    },
  );

  // Login
  fastify.post(
    "/login",
    {
      schema: {
        tags: ["auth"],
      },
    },
    async (request, reply) => {
      const input = validateSchema(loginSchema, request.body);
      const result = await authService.login(input);

      // Set session cookie
      reply.setCookie(COOKIE_NAME, result.sessionId, {
        httpOnly: true,
        secure: env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: env.SESSION_EXPIRY_HOURS * 60 * 60,
        path: "/",
      });

      return reply.send({
        success: true,
        data: {
          id: result.id,
          username: result.username,
          created_at: result.created_at,
          updated_at: result.updated_at,
        },
        message: "Logged in successfully",
      });
    },
  );

  // Logout
  fastify.post("/logout", {
    schema: {
      tags: ["auth"],
    },
    preHandler: authenticateUser,
    handler: async (request, reply) => {
      const sessionId = request.cookies[COOKIE_NAME];

      if (sessionId) {
        await authService.logout(sessionId);
      }

      reply.clearCookie(COOKIE_NAME);

      return reply.send({
        success: true,
        message: "Logged out successfully",
      });
    },
  });

  // Get current user
  fastify.get("/me", {
    schema: {
      tags: ["auth"],
    },
    preHandler: authenticateUser,
    handler: async (request, reply) => {
      if (!request.user) {
        return reply.status(401).send({
          success: false,
          message: "Not authenticated",
        });
      }

      const user = await authService.getMe(request.user.id);

      return reply.send({
        success: true,
        data: user,
      });
    },
  });
}
