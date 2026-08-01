import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { conversionService } from "./conversion.service";
import { authenticateUser } from "@/modules/auth/auth.middleware";
import { existsSync, createReadStream, statSync } from "fs";
import { randomUUID } from "crypto";
import { NotFoundError } from "@/utils/errors";
import { markRouteDeprecated } from "@/utils/api-deprecation";
import { env } from "@/config/env";
import {
  createConversionJobSchema,
  conversionJobResponseSchema,
  listConversionJobsResponseSchema,
  listPresetsResponseSchema,
  videoIdParamSchema,
  jobIdParamSchema,
  bulkConversionSchema,
  bulkConversionResponseSchema,
  listActiveConversionsResponseSchema,
  clearQueueResponseSchema,
  conversionHistoryQuerySchema,
  conversionHistoryOverviewQuerySchema,
  conversionHistoryResponseSchema,
  conversionHistoryOverviewResponseSchema,
  conversionHistoryFacetsResponseSchema,
  conversionInsightsResponseSchema,
  conversionQueueStatusResponseSchema,
  updateConversionJobSchema,
} from "./conversion.schemas";
import type {
  ConversionHistoryFilters,
  ConversionHistoryListOptions,
} from "./conversion.types";

async function createVideoConversionJob(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const { id } = request.params as { id: number };
  const { preset, deleteOriginal } = request.body as {
    preset: string;
    deleteOriginal?: boolean;
  };

  const job = await conversionService.createJob({
    video_id: id,
    preset,
    deleteOriginal,
  });

  return reply.status(201).send({ success: true, data: job });
}

async function createBulkConversionJobs(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const { videoIds, preset, deleteOriginal } = request.body as {
    videoIds: number[];
    preset: string;
    deleteOriginal?: boolean;
  };
  const batchId = randomUUID();

  const jobs = await conversionService.bulkCreateJobs({
    videoIds,
    preset,
    deleteOriginal,
    batchId,
  });

  return reply.status(201).send({
    success: true,
    data: {
      batchId,
      jobs,
    },
  });
}

export async function videoConversionRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // All routes require authentication
  app.addHook("preHandler", authenticateUser);

  /**
   * Create a conversion job for a video
   * POST /videos/:id/convert
   */
  app.post(
    "/:id/conversions",
    {
      schema: {
        tags: ["conversion"],
        summary: "Start video conversion",
        description:
          "Create a new conversion job resource for a video with the specified preset.",
        params: videoIdParamSchema,
        body: createConversionJobSchema,
        response: {
          201: conversionJobResponseSchema,
        },
      },
    },
    createVideoConversionJob
  );

  app.post(
    "/:id/convert",
    {
      schema: {
        tags: ["conversion"],
        deprecated: true,
        summary: "Start video conversion (deprecated)",
        description: "Deprecated alias for POST /api/videos/:id/conversions.",
        params: videoIdParamSchema,
        body: createConversionJobSchema,
        response: {
          201: conversionJobResponseSchema,
        },
      },
    },
    async (request, reply) => {
      markRouteDeprecated(reply, {
        replacement: "/api/videos/:id/conversions",
      });
      return createVideoConversionJob(request, reply);
    }
  );

  app.post(
    "/convert/bulk",
    {
      schema: {
        tags: ["conversion"],
        deprecated: true,
        summary: "Bulk start video conversions (deprecated)",
        description:
          "Deprecated alias for POST /api/conversions. Start conversion jobs for multiple videos.",
        body: bulkConversionSchema,
        response: {
          201: bulkConversionResponseSchema,
        },
      },
    },
    async (request, reply) => {
      markRouteDeprecated(reply, { replacement: "/api/conversions" });
      return createBulkConversionJobs(request, reply);
    }
  );

  app.get(
    "/convert/queue",
    {
      schema: {
        tags: ["conversion"],
        deprecated: true,
        summary: "Get conversion queue (deprecated)",
        description:
          "Deprecated alias for GET /api/conversions/queue. Get all videos currently in the conversion queue.",
        response: {
          200: z.object({
            success: z.literal(true),
            data: z.array(z.unknown()),
          }),
        },
      },
    },
    async (request, reply) => {
      markRouteDeprecated(reply, { replacement: "/api/conversions/queue" });
      const userId = request.user!.id;
      const queue = await conversionService.getQueue(userId);
      return reply.send({ success: true, data: queue });
    }
  );

  /**
   * List conversion jobs for a video
   * GET /videos/:id/conversions
   */
  app.get(
    "/:id/conversions",
    {
      schema: {
        tags: ["conversion"],
        summary: "List conversion jobs for video",
        description: "Get all conversion jobs associated with a specific video",
        params: videoIdParamSchema,
        response: {
          200: listConversionJobsResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: number };
      const jobs = await conversionService.listByVideoId(id);
      return reply.send({ success: true, data: jobs });
    }
  );
}

export async function conversionRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // All routes require authentication
  app.addHook("preHandler", authenticateUser);

  app.post(
    "/",
    {
      schema: {
        tags: ["conversion"],
        summary: "Create bulk conversion jobs",
        description:
          "Create conversion job resources for multiple videos in one request.",
        body: bulkConversionSchema,
        response: {
          201: bulkConversionResponseSchema,
        },
      },
    },
    createBulkConversionJobs
  );

  app.get(
    "/queue",
    {
      schema: {
        tags: ["conversion"],
        summary: "Get conversion queue",
        description: "Get all videos currently in the conversion queue.",
        response: {
          200: z.object({
            success: z.literal(true),
            data: z.array(z.unknown()),
          }),
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const queue = await conversionService.getQueue(userId);
      return reply.send({ success: true, data: queue });
    }
  );

  /**
   * List completed conversion history
   * GET /conversions/history
   */
  app.get(
    "/history",
    {
      schema: {
        tags: ["conversion"],
        summary: "List conversion history",
        description:
          "Returns completed conversion history including source/output sizes and FFmpeg command used.",
        querystring: conversionHistoryQuerySchema,
        response: {
          200: conversionHistoryResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const query = request.query as ConversionHistoryListOptions;
      const history = await conversionService.getHistory(query);

      return reply.send({
        success: true,
        data: history.items,
        meta: {
          total: history.total,
          limit: history.limit,
          offset: history.offset,
        },
      });
    }
  );

  /**
   * Aggregate metrics for the (optionally filtered) history
   * GET /conversions/history/overview
   */
  app.get(
    "/history/overview",
    {
      schema: {
        tags: ["conversion"],
        summary: "Get conversion history overview",
        description:
          "Returns aggregate metrics for completed conversion history.",
        querystring: conversionHistoryOverviewQuerySchema,
        response: {
          200: conversionHistoryOverviewResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const overview = await conversionService.getHistoryOverview(
        request.query as ConversionHistoryFilters
      );

      return reply.send({ success: true, data: overview });
    }
  );

  /**
   * Compression insights derived from the history
   * GET /conversions/history/insights
   */
  app.get(
    "/history/insights",
    {
      schema: {
        tags: ["conversion"],
        summary: "Get conversion insights",
        description:
          "Breaks the conversion history down by preset and by source characteristics " +
          "(bitrate, resolution, codec, frame rate) so compression profiles can be tuned.",
        querystring: conversionHistoryOverviewQuerySchema,
        response: {
          200: conversionInsightsResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const insights = await conversionService.getHistoryInsights(
        request.query as ConversionHistoryFilters
      );

      return reply.send({ success: true, data: insights });
    }
  );

  /**
   * Distinct values available for history filters
   * GET /conversions/history/facets
   */
  app.get(
    "/history/facets",
    {
      schema: {
        tags: ["conversion"],
        summary: "Get conversion history filter facets",
        description:
          "Returns the distinct presets and source codecs present in the history.",
        response: {
          200: conversionHistoryFacetsResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      const facets = await conversionService.getHistoryFacets();
      return reply.send({ success: true, data: facets });
    }
  );

  app.get(
    "/:id",
    {
      schema: {
        tags: ["conversion"],
        summary: "Get conversion job",
        description: "Get details of a specific conversion job",
        params: jobIdParamSchema,
        response: {
          200: conversionJobResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: number };
      const job = await conversionService.findById(id);
      return reply.send({ success: true, data: job });
    }
  );

  /**
   * Cancel a pending conversion job
   * POST /conversions/:id/cancel
   */
  app.patch(
    "/:id",
    {
      schema: {
        tags: ["conversion"],
        summary: "Update conversion job state",
        description:
          "Update a conversion job. Currently only cancellation is supported by setting status=cancelled.",
        params: jobIdParamSchema,
        body: updateConversionJobSchema,
        response: {
          200: conversionJobResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: number };
      const job = await conversionService.cancel(id);
      return reply.send({ success: true, data: job });
    }
  );

  app.post(
    "/:id/cancel",
    {
      schema: {
        tags: ["conversion"],
        deprecated: true,
        summary: "Cancel conversion job (deprecated)",
        description:
          "Deprecated alias for PATCH /api/conversions/:id with body { status: 'cancelled' }.",
        params: jobIdParamSchema,
        response: {
          200: conversionJobResponseSchema,
        },
      },
    },
    async (request, reply) => {
      markRouteDeprecated(reply, {
        replacement: "/api/conversions/:id",
        details: "Send { status: 'cancelled' } in the request body.",
      });
      const { id } = request.params as { id: number };
      const job = await conversionService.cancel(id);
      return reply.send({ success: true, data: job });
    }
  );

  /**
   * Delete a conversion job
   * DELETE /conversions/:id
   */
  app.delete(
    "/:id",
    {
      schema: {
        tags: ["conversion"],
        summary: "Delete conversion job",
        description:
          "Delete a completed/failed/cancelled conversion job and its output file",
        params: jobIdParamSchema,
        response: {
          200: z.object({
            success: z.literal(true),
            message: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: number };
      await conversionService.delete(id);
      return reply.send({ success: true, message: "Job deleted" });
    }
  );

  /**
   * Download converted file
   * GET /conversions/:id/download
   */
  app.get(
    "/:id/download",
    {
      schema: {
        tags: ["conversion"],
        summary: "Download converted file",
        description: "Download the output file from a completed conversion job",
        params: jobIdParamSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: number };

      if (env.DEMO_MODE) {
        const download = conversionService.getDemoDownload(id);
        return reply
          .header("Content-Type", "text/plain; charset=utf-8")
          .header(
            "Content-Disposition",
            `attachment; filename="${download.filename}"`
          )
          .header("Content-Length", download.content.length)
          .send(download.content);
      }

      const job = await conversionService.findById(id);

      if (job.status !== "completed" || !job.output_path) {
        throw new NotFoundError(
          "Conversion not completed or output file not available"
        );
      }

      if (!existsSync(job.output_path)) {
        throw new NotFoundError("Output file not found on disk");
      }

      const stats = statSync(job.output_path);
      const fileName = job.output_path.split("/").pop() || "converted.mkv";

      return reply
        .header("Content-Type", "video/x-matroska")
        .header("Content-Disposition", `attachment; filename="${fileName}"`)
        .header("Content-Length", stats.size)
        .send(createReadStream(job.output_path));
    }
  );

  /**
   * List available presets
   * GET /presets
   */
  app.get(
    "/active",
    {
      schema: {
        tags: ["conversion"],
        summary: "Get active conversions",
        description:
          "Get all currently pending and processing conversions with their progress",
        response: {
          200: listActiveConversionsResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      const conversions = await conversionService.getActiveConversions();
      return reply.send({ success: true, data: conversions });
    }
  );

  /**
   * Clear conversion queue
   * POST /conversions/queue/clear
   */
  app.post(
    "/queue/clear",
    {
      schema: {
        tags: ["conversion"],
        summary: "Clear conversion queue",
        description:
          "Clear all pending jobs and reset stuck processing jobs to failed status",
        response: {
          200: clearQueueResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      const result = await conversionService.clearQueue();
      return reply.send({
        success: true,
        data: {
          ...result,
          message: "Queue cleared successfully",
        },
      });
    }
  );
}

export async function conversionStatusRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.addHook("preHandler", authenticateUser);

  app.get(
    "/queue/status",
    {
      schema: {
        tags: ["conversion"],
        summary: "Get queue status",
        description: "Get the current status of the conversion queue",
        response: {
          200: conversionQueueStatusResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      const status = await conversionService.getQueueStatus();
      return reply.send({ success: true, data: status });
    }
  );

  app.get(
    "/status",
    {
      schema: {
        tags: ["conversion"],
        deprecated: true,
        summary: "Get queue status (deprecated)",
        description: "Deprecated alias for GET /api/conversions/queue/status.",
        response: {
          200: conversionQueueStatusResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      markRouteDeprecated(reply, {
        replacement: "/api/conversions/queue/status",
      });
      const status = await conversionService.getQueueStatus();
      return reply.send({ success: true, data: status });
    }
  );
}

export async function deprecatedConversionLegacyStatusRoutes(
  fastify: FastifyInstance
) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.addHook("preHandler", authenticateUser);

  app.get(
    "/status",
    {
      schema: {
        tags: ["conversion"],
        deprecated: true,
        summary: "Get queue status (deprecated legacy path)",
        description:
          "Deprecated legacy alias for GET /api/conversions/queue/status.",
        response: {
          200: conversionQueueStatusResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      markRouteDeprecated(reply, {
        replacement: "/api/conversions/queue/status",
      });
      const status = await conversionService.getQueueStatus();
      return reply.send({ success: true, data: status });
    }
  );
}

export async function conversionPresetsRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.addHook("preHandler", authenticateUser);

  app.get(
    "/",
    {
      schema: {
        tags: ["conversion"],
        summary: "List available presets",
        description: "Get all available conversion presets.",
        response: {
          200: listPresetsResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      const presets = conversionService.getPresets();
      return reply.send({ success: true, data: presets });
    }
  );
}

export async function deprecatedConversionPresetsRoutes(
  fastify: FastifyInstance
) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.addHook("preHandler", authenticateUser);

  app.get(
    "/",
    {
      schema: {
        tags: ["conversion"],
        deprecated: true,
        summary: "List available presets (deprecated alias)",
        description: "Deprecated alias for GET /api/conversions/presets.",
        response: {
          200: listPresetsResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      markRouteDeprecated(reply, { replacement: "/api/conversions/presets" });
      const presets = conversionService.getPresets();
      return reply.send({ success: true, data: presets });
    }
  );
}
