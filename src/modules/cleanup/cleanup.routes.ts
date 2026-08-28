import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { authenticateUser } from "@/modules/auth/auth.middleware";
import { cleanupService } from "./cleanup.service";
import {
  cleanupCandidatesQuerySchema,
  cleanupCandidatesResponseSchema,
  cleanupErrorResponseSchema,
  cleanupOverviewResponseSchema,
  cleanupVideoParamsSchema,
  saveCleanupReviewResponseSchema,
  saveCleanupReviewSchema,
} from "./cleanup.schemas";

export async function cleanupRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.addHook("preHandler", authenticateUser);
  app.get(
    "/overview",
    {
      schema: {
        tags: ["cleanup"],
        summary: "Get cleanup progress and rewards",
        response: {
          200: cleanupOverviewResponseSchema,
          401: cleanupErrorResponseSchema,
        },
      },
    },
    async (request, reply) =>
      reply.send({
        success: true,
        data: await cleanupService.overview(request.user!.id),
      })
  );
  app.get(
    "/candidates",
    {
      schema: {
        tags: ["cleanup"],
        summary: "List ranked cleanup candidates",
        querystring: cleanupCandidatesQuerySchema,
        response: {
          200: cleanupCandidatesResponseSchema,
          401: cleanupErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await cleanupService.listCandidates(
        request.user!.id,
        request.query
      );
      return reply.send({
        success: true,
        data: result.data,
        pagination: {
          offset: request.query.offset,
          limit: request.query.limit,
          total: result.total,
        },
      });
    }
  );
  app.put(
    "/reviews/:videoId",
    {
      schema: {
        tags: ["cleanup"],
        summary: "Save a non-destructive cleanup decision",
        params: cleanupVideoParamsSchema,
        body: saveCleanupReviewSchema,
        response: {
          200: saveCleanupReviewResponseSchema,
          401: cleanupErrorResponseSchema,
          404: cleanupErrorResponseSchema,
          409: cleanupErrorResponseSchema,
        },
      },
    },
    async (request, reply) =>
      reply.send({
        success: true,
        data: await cleanupService.saveReview(
          request.user!.id,
          request.params.videoId,
          request.body.disposition,
          request.body.expected_revision
        ),
      })
  );
}
