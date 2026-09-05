import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { authenticateUser } from "@/modules/auth/auth.middleware";
import { markRouteDeprecated } from "@/utils/api-deprecation";
import { triageService } from "./triage.service";
import {
  saveTriageProgressSchema,
  getTriageProgressQuerySchema,
  triageProgressResponseSchema,
  saveTriageProgressResponseSchema,
  triageBulkActionsSchema,
  triageBulkActionsResultSchema,
  triageStatisticsResponseSchema,
  errorResponseSchema,
} from "./triage.schemas";

export async function triageRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.addHook("preHandler", authenticateUser);

  app.post(
    "/progress",
    {
      schema: {
        tags: ["triage"],
        summary: "Save triage progress",
        description:
          "Persist triage session progress for resuming later. Uses upsert logic to update existing progress.",
        body: saveTriageProgressSchema,
        response: {
          200: saveTriageProgressResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      await triageService.saveProgress(request.user!.id, request.body);

      return reply.send({
        success: true,
        message: "Progress saved",
      });
    },
  );

  app.get(
    "/progress",
    {
      schema: {
        tags: ["triage"],
        summary: "Get triage progress",
        description:
          "Retrieve saved triage progress for a specific filter key. Returns null if no progress exists.",
        querystring: getTriageProgressQuerySchema,
        response: {
          200: triageProgressResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const progress = await triageService.getProgress(
        request.user!.id,
        request.query,
      );

      return reply.send({
        success: true,
        data: progress
          ? {
              filter_key: progress.filter_key,
              last_video_id: progress.last_video_id,
              processed_count: progress.processed_count,
              total_count: progress.total_count,
              updated_at: progress.updated_at,
            }
          : null,
      });
    },
  );

  app.post(
    "/bulk-actions",
    {
      schema: {
        tags: ["videos", "triage"],
        summary: "Apply triage bulk actions",
        description:
          "Add or remove creators, tags, and studios from multiple videos at once as part of the triage workflow.",
        body: triageBulkActionsSchema,
        response: {
          200: triageBulkActionsResultSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await triageService.applyBulkActions(request.body);

      return reply.send({
        success: true,
        data: {
          processed: result.processed,
          errors: result.errors,
          details: result.details,
        },
      });
    },
  );

  app.get(
    "/stats",
    {
      schema: {
        tags: ["triage"],
        summary: "Get triage statistics",
        description:
          "Returns overview statistics about the triage queue including total untagged videos, progress breakdown, and directory statistics.",
        response: {
          200: triageStatisticsResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const stats = await triageService.getStatistics(request.user!.id);

      return reply.send({
        success: true,
        data: stats,
      });
    },
  );
}

export async function usersTriageLegacyRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.addHook("preHandler", authenticateUser);

  app.post(
    "/triage-progress",
    {
      schema: {
        tags: ["triage"],
        deprecated: true,
        summary: "Save triage progress (deprecated)",
        description: "Deprecated alias for POST /api/triage/progress.",
        body: saveTriageProgressSchema,
        response: {
          200: saveTriageProgressResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      markRouteDeprecated(reply, { replacement: "/api/triage/progress" });
      await triageService.saveProgress(request.user!.id, request.body);

      return reply.send({
        success: true,
        message: "Progress saved",
      });
    },
  );

  app.get(
    "/triage-progress",
    {
      schema: {
        tags: ["triage"],
        deprecated: true,
        summary: "Get triage progress (deprecated)",
        description: "Deprecated alias for GET /api/triage/progress.",
        querystring: getTriageProgressQuerySchema,
        response: {
          200: triageProgressResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      markRouteDeprecated(reply, { replacement: "/api/triage/progress" });
      const progress = await triageService.getProgress(
        request.user!.id,
        request.query,
      );

      return reply.send({
        success: true,
        data: progress
          ? {
              filter_key: progress.filter_key,
              last_video_id: progress.last_video_id,
              processed_count: progress.processed_count,
              total_count: progress.total_count,
              updated_at: progress.updated_at,
            }
          : null,
      });
    },
  );

  app.post(
    "/triage/bulk-actions",
    {
      schema: {
        tags: ["triage"],
        deprecated: true,
        summary: "Apply triage bulk actions (deprecated)",
        description: "Deprecated alias for POST /api/triage/bulk-actions.",
        body: triageBulkActionsSchema,
        response: {
          200: triageBulkActionsResultSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      markRouteDeprecated(reply, { replacement: "/api/triage/bulk-actions" });
      const result = await triageService.applyBulkActions(request.body);

      return reply.send({
        success: true,
        data: {
          processed: result.processed,
          errors: result.errors,
          details: result.details,
        },
      });
    },
  );

  app.get(
    "/triage/statistics",
    {
      schema: {
        tags: ["triage"],
        deprecated: true,
        summary: "Get triage statistics (deprecated)",
        description: "Deprecated alias for GET /api/triage/stats.",
        response: {
          200: triageStatisticsResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      markRouteDeprecated(reply, { replacement: "/api/triage/stats" });
      const stats = await triageService.getStatistics(request.user!.id);

      return reply.send({
        success: true,
        data: stats,
      });
    },
  );
}
