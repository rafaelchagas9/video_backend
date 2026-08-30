import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { authenticateUser } from "@/modules/auth/auth.middleware";
import { API_PREFIX } from "@/config/constants";
import { env } from "@/config/env";
import { AppError, ConflictError } from "@/utils/errors";
import {
  ContentAnalysisAnalyzerChangedError,
  ContentAnalysisIdempotencyConflictError,
  RetryableContentAnalysisError,
} from "./content-analysis.store";
import type { ContentAnalysisService } from "./content-analysis.service";
import type { ContentAnalysisRun } from "./content-analysis.types";
import {
  contentAnalysisIdempotencyHeadersSchema,
  contentAnalysisIdParamSchema,
  contentAnalysisJobResponseSchema,
  contentAnalysisStartedResponseSchema,
  startNudityAnalysisBodySchema,
} from "./content-analysis.schemas";

export interface ContentAnalysisRoutesOptions {
  service?: Pick<ContentAnalysisService, "start" | "get" | "cancel">;
}

function serializeRun(run: ContentAnalysisRun) {
  const percent = Math.min(
    100,
    Math.max(0, (run.scannedSeconds / run.sourceDurationSeconds) * 100)
  );
  return {
    id: run.id,
    video_id: run.videoId,
    kind: run.kind,
    profile: run.profile,
    requested_categories: run.requestedCategories,
    status: run.status,
    phase: run.phase,
    progress: {
      scanned_seconds: run.scannedSeconds,
      source_duration_seconds: run.sourceDurationSeconds,
      percent,
      sampled_frames: run.sampledFrames,
      positive_frames: run.positiveFrames,
    },
    revisions: {
      analyzer: run.analyzerRevision,
      model: run.modelRevision,
      taxonomy: run.taxonomyRevision,
      config: run.configRevision,
    },
    result: {
      event_count: run.resultEventCount,
      bookmark_count: run.resultBookmarkCount,
    },
    error:
      run.errorCode && run.errorMessage
        ? { code: run.errorCode, message: run.errorMessage }
        : null,
    retry_count: run.retryCount,
    created_at: run.createdAt.toISOString(),
    updated_at: run.updatedAt.toISOString(),
    started_at: run.startedAt?.toISOString() ?? null,
    completed_at: run.completedAt?.toISOString() ?? null,
    cancelled_at: run.cancelledAt?.toISOString() ?? null,
  };
}

function mapStartError(error: unknown): never {
  if (error instanceof ContentAnalysisIdempotencyConflictError) {
    throw new ConflictError(error.message);
  }
  if (error instanceof ContentAnalysisAnalyzerChangedError) {
    throw new ConflictError(error.message);
  }
  if (error instanceof RetryableContentAnalysisError) {
    throw new AppError(503, error.message);
  }
  throw error;
}

export async function contentAnalysisRoutes(
  fastify: FastifyInstance,
  options: ContentAnalysisRoutesOptions = {}
): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const service = options.service
    ? options.service
    : env.DEMO_MODE
      ? (await import("./content-analysis.demo.service"))
          .demoContentAnalysisService
      : (await import("./content-analysis.runtime")).getContentAnalysisRuntime()
          .service;

  app.post(
    "/videos/:id/analyses/nudity",
    {
      preHandler: authenticateUser,
      schema: {
        tags: ["content-analysis"],
        summary: "Queue durable nudity analysis for a video",
        params: contentAnalysisIdParamSchema,
        headers: contentAnalysisIdempotencyHeadersSchema,
        body: startNudityAnalysisBodySchema,
        response: { 202: contentAnalysisStartedResponseSchema },
      },
    },
    async (request, reply) => {
      try {
        const result = await service.start({
          videoId: request.params.id,
          userId: request.user!.id,
          profile: request.body.profile,
          categories: request.body.categories,
          force: request.body.force,
          idempotencyKey: request.headers["idempotency-key"],
        });
        const location = `${API_PREFIX}/content-analysis/jobs/${result.run.id}`;
        return reply
          .code(202)
          .header("Location", location)
          .send({
            success: true,
            data: { job: serializeRun(result.run), reused: result.reused },
            message: result.reused
              ? "Equivalent content analysis reused"
              : "Content analysis queued",
          });
      } catch (error) {
        mapStartError(error);
      }
    }
  );

  app.get(
    "/content-analysis/jobs/:id",
    {
      preHandler: authenticateUser,
      schema: {
        tags: ["content-analysis"],
        summary: "Inspect a content analysis job",
        params: contentAnalysisIdParamSchema,
        response: { 200: contentAnalysisJobResponseSchema },
      },
    },
    async (request, reply) => {
      const run = await service.get(request.params.id, request.user!.id);
      return reply.send({ success: true, data: serializeRun(run) });
    }
  );

  app.delete(
    "/content-analysis/jobs/:id",
    {
      preHandler: authenticateUser,
      schema: {
        tags: ["content-analysis"],
        summary: "Cancel a queued or running content analysis job",
        params: contentAnalysisIdParamSchema,
        response: { 200: contentAnalysisJobResponseSchema },
      },
    },
    async (request, reply) => {
      const run = await service.cancel(request.params.id, request.user!.id);
      return reply.send({ success: true, data: serializeRun(run) });
    }
  );
}
