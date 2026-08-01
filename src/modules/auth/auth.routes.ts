import { fromNodeHeaders } from "better-auth/node";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { authService } from "./auth.service";
import { authenticateUser } from "./auth.middleware";
import {
  authSuccessResponseSchema,
  errorResponseSchema,
  loginBodySchema,
  logoutResponseSchema,
  meResponseSchema,
  registerBodySchema,
} from "./auth.schemas";

function forwardSetCookieHeaders(reply: FastifyReply, response: Response): void {
  const getSetCookie = response.headers.getSetCookie?.bind(response.headers);
  const cookies = getSetCookie ? getSetCookie() : [];

  if (cookies.length > 0) {
    reply.header("set-cookie", cookies);
    return;
  }

  const header = response.headers.get("set-cookie");
  if (header) {
    reply.header("set-cookie", header);
  }
}

export async function authRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.post(
    "/register",
    {
      schema: {
        tags: ["auth"],
        summary: "Register a new user",
        description:
          "Create a new Better Auth account using email and password.",
        body: registerBodySchema,
        response: {
          201: authSuccessResponseSchema,
          400: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { user, response } = await authService.register(
        request.body,
        request.headers,
      );

      forwardSetCookieHeaders(reply, response);

      return reply.status(201).send({
        success: true,
        data: user,
        message: "User created successfully",
      });
    },
  );

  app.post(
    "/login",
    {
      schema: {
        tags: ["auth"],
        summary: "Login to an existing account",
        description:
          "Authenticate with email and password. Legacy username login is also accepted for migrated accounts. Returns Better Auth session cookies.",
        body: loginBodySchema,
        response: {
          200: authSuccessResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { user, response } = await authService.login(
        request.body,
        request.headers,
      );

      forwardSetCookieHeaders(reply, response);

      return reply.send({
        success: true,
        data: user,
        message: "Logged in successfully",
      });
    },
  );

  app.post("/logout", {
    schema: {
      tags: ["auth"],
      summary: "Logout from current session",
      description:
        "Invalidate the current Better Auth session and clear auth cookies.",
      response: {
        200: logoutResponseSchema,
        401: errorResponseSchema,
      },
    },
    preHandler: authenticateUser,
    handler: async (request, reply) => {
      const response = await authService.logout(request.headers);
      forwardSetCookieHeaders(reply, response);

      return reply.send({
        success: true,
        message: "Logged out successfully",
      });
    },
  });

  app.get("/me", {
    schema: {
      tags: ["auth"],
      summary: "Get current user info",
      description: "Returns the currently authenticated Better Auth user.",
      response: {
        200: meResponseSchema,
        401: errorResponseSchema,
      },
    },
    preHandler: authenticateUser,
    handler: async (request, reply) => {
      const user = await authService.getMe(request.headers);

      return reply.send({
        success: true,
        data: user,
      });
    },
  });

  app.route({
    method: ["GET", "POST"],
    url: "/*",
    schema: {
      hide: true,
    },
    async handler(request, reply) {
      const { auth } = await import("@/lib/auth");
      const url = new URL(request.url, `http://${request.headers.host}`);
      const headers = fromNodeHeaders(request.headers);
      const response = await auth.handler(
        new Request(url.toString(), {
          method: request.method,
          headers,
          ...(request.body === undefined
            ? {}
            : { body: JSON.stringify(request.body) }),
        }),
      );

      reply.status(response.status);
      response.headers.forEach((value, key) => {
        if (key.toLowerCase() === "set-cookie") {
          return;
        }

        reply.header(key, value);
      });
      forwardSetCookieHeaders(reply, response);

      return reply.send(response.body ? await response.text() : null);
    },
  });
}
