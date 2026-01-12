import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { authenticateUser } from "@/modules/auth/auth.middleware";
import { videoStatsService } from "./video-stats.service";
import {
  idParamSchema,
  watchUpdateSchema,
  watchUpdateResponseSchema,
  statsResponseSchema,
  errorResponseSchema,
} from "./video-stats.schemas";

export async function videoStatsRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.addHook("preHandler", authenticateUser);

  app.post(
    "/:id/watch",
    {
      schema: {
        tags: ["video-stats"],
        summary: "Record video watch stats",
        description: "Updates per-user watch statistics for a video.",
        params: idParamSchema,
        body: watchUpdateSchema,
        response: {
          200: watchUpdateResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await videoStatsService.recordWatch(
        request.user!.id,
        request.params.id,
        request.body,
      );

      return reply.send({
        success: true,
        data: result,
      });
    },
  );

  app.get(
    "/:id/stats",
    {
      schema: {
        tags: ["video-stats"],
        summary: "Get video watch stats",
        description:
          "Returns per-user and aggregate watch statistics for a video.",
        params: idParamSchema,
        response: {
          200: statsResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await videoStatsService.getStats(
        request.user!.id,
        request.params.id,
      );

      return reply.send({
        success: true,
        data: result,
      });
    },
  );
}
