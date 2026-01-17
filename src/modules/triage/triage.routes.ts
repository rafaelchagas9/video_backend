import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { authenticateUser } from "@/modules/auth/auth.middleware";
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

  // Save triage progress
  app.post(
    "/triage-progress",
    {
      schema: {
        tags: ["users", "triage"],
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

  // Get triage progress
  app.get(
    "/triage-progress",
    {
      schema: {
        tags: ["users", "triage"],
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

  // Apply bulk actions to multiple videos
  app.post(
    "/triage/bulk-actions",
    {
      schema: {
        tags: ["videos", "triage"],
        summary: "Apply bulk actions to multiple videos",
        description:
          "Add or remove creators, tags, and studios from multiple videos at once. Useful for triage batch operations.",
        body: triageBulkActionsSchema,
        response: {
          200: triageBulkActionsResultSchema,
          401: errorResponseSchema,
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

  // Get triage statistics
  app.get(
    "/triage/statistics",
    {
      schema: {
        tags: ["videos", "triage"],
        summary: "Get triage statistics",
        description:
          "Returns overview statistics about the triage queue including total untagged videos, progress breakdown, and directory statistics.",
        response: {
          200: triageStatisticsResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      const stats = await triageService.getStatistics();

      return reply.send({
        success: true,
        data: stats,
      });
    },
  );
}
