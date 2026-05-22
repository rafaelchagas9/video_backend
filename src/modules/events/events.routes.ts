import type { FastifyInstance } from "fastify";
import { COOKIE_NAME } from "@/config/constants";
import { authenticateUser } from "@/modules/auth/auth.middleware";
import { eventsService } from "./events.service";

export async function eventsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    "/stream",
    {
      preHandler: authenticateUser,
      schema: {
        tags: ["events"],
        summary: "Open SSE stream",
        description:
          "Streams authenticated real-time task updates with server-sent events.",
      },
    },
    async (request, reply) => {
      const sessionId = request.cookies[COOKIE_NAME];
      const userId = request.user?.id;

      if (!sessionId || !userId) {
        return reply
          .status(401)
          .type("application/json")
          .send({
            success: false,
            error: {
              message: "Invalid or expired session. Please log in again.",
              statusCode: 401,
            },
          });
      }

      reply.raw.statusCode = 200;
      const originHeader = request.headers.origin;
      if (typeof originHeader === "string" && originHeader.length > 0) {
        reply.raw.setHeader("Access-Control-Allow-Origin", originHeader);
        reply.raw.setHeader("Access-Control-Allow-Credentials", "true");
        reply.raw.setHeader("Vary", "Origin");
      }
      reply.raw.setHeader("Content-Type", "text/event-stream");
      reply.raw.setHeader("Cache-Control", "no-cache");
      reply.raw.setHeader("Connection", "keep-alive");
      reply.raw.setHeader("X-Accel-Buffering", "no");

      reply.hijack();
      reply.raw.flushHeaders?.();

      eventsService.addAuthenticatedClient({
        response: reply.raw,
        userId,
        sessionId,
      });
    },
  );
}
