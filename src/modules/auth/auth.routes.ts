import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { authService } from "./auth.service";
import {
  registerBodySchema,
  loginBodySchema,
  authSuccessResponseSchema,
  meResponseSchema,
  logoutResponseSchema,
  errorResponseSchema,
} from "./auth.schemas";
import { authenticateUser } from "./auth.middleware";
import { COOKIE_NAME } from "@/config/constants";
import { env } from "@/config/env";

export async function authRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // Register new user
  app.post(
    "/register",
    {
      schema: {
        tags: ["auth"],
        summary: "Register a new user",
        description:
          "Create a new user account. Only one user can be registered (single-user system).",
        body: registerBodySchema,
        response: {
          201: authSuccessResponseSchema,
          400: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const user = await authService.register(request.body);

      return reply.status(201).send({
        success: true,
        data: user,
        message: "User created successfully",
      });
    },
  );

  // Login
  app.post(
    "/login",
    {
      schema: {
        tags: ["auth"],
        summary: "Login to an existing account",
        description:
          "Authenticate with username and password. Returns a session cookie.",
        body: loginBodySchema,
        response: {
          200: authSuccessResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await authService.login(request.body);

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
  app.post("/logout", {
    schema: {
      tags: ["auth"],
      summary: "Logout from current session",
      description:
        "Invalidate the current session and clear the session cookie.",
      response: {
        200: logoutResponseSchema,
        401: errorResponseSchema,
      },
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
  app.get("/me", {
    schema: {
      tags: ["auth"],
      summary: "Get current user info",
      description: "Returns the currently authenticated user's information.",
      response: {
        200: meResponseSchema,
        401: errorResponseSchema,
      },
    },
    preHandler: authenticateUser,
    handler: async (request, reply) => {
      if (!request.user) {
        return reply.status(401).send({
          success: false,
          error: {
            message: "Not authenticated",
            statusCode: 401,
          },
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
