import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { API_PREFIX } from "@/config/constants";
import { env } from "@/config/env";
import { authenticateUser } from "@/modules/auth/auth.middleware";
import {
  COPY_ENGINE_NOT_READY_CODE,
  COPY_ENGINE_NOT_READY_REASON,
  isCopyEngineNotReadyError,
} from "./perceptual-readiness";
import {
  perceptualDuplicatesJobIdParamsSchema,
  perceptualDuplicatesJobResponseSchema,
  perceptualDuplicatesStartedResponseSchema,
  startPerceptualDuplicatesBodySchema,
} from "./perceptual-duplicates.schemas";
import type {
  PerceptualDuplicatesJobView,
  PerceptualDuplicatesServiceContract,
} from "./perceptual-duplicates.types";

export interface PerceptualDuplicatesRoutesOptions {
  service?: PerceptualDuplicatesServiceContract;
}

function serializeJob(job: PerceptualDuplicatesJobView) {
  return {
    id: job.id,
    video_ids: job.videoIds,
    status: job.status,
    phase: job.phase,
    progress: {
      completed_units: job.completedUnits,
      total_units: job.totalUnits,
    },
    result: job.result,
    error: job.error,
    retry_count: job.retryCount,
    created_at: job.createdAt.toISOString(),
    updated_at: job.updatedAt.toISOString(),
    started_at: job.startedAt?.toISOString() ?? null,
    completed_at: job.completedAt?.toISOString() ?? null,
    cancelled_at: job.cancelledAt?.toISOString() ?? null,
  };
}

function sendDemoUnavailable(reply: FastifyReply) {
  return reply.code(503).send({
    success: false,
    error: {
      code: "PERCEPTUAL_DUPLICATES_UNAVAILABLE_IN_DEMO",
      message: "Perceptual duplicate comparison is unavailable in demo mode",
      statusCode: 503,
    },
  });
}

function isRuntimeUnavailable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "PERCEPTUAL_DUPLICATES_UNAVAILABLE"
  );
}

function sendRuntimeUnavailable(reply: FastifyReply) {
  return reply.code(503).send({
    success: false,
    error: {
      code: "PERCEPTUAL_DUPLICATES_UNAVAILABLE",
      message: "Perceptual duplicate comparison is unavailable",
      statusCode: 503,
    },
  });
}

function sendEngineNotReady(reply: FastifyReply) {
  return reply.code(503).send({
    success: false,
    error: {
      code: COPY_ENGINE_NOT_READY_CODE,
      message: COPY_ENGINE_NOT_READY_REASON,
      statusCode: 503,
    },
  });
}

export async function perceptualDuplicatesRoutes(
  fastify: FastifyInstance,
  options: PerceptualDuplicatesRoutesOptions = {}
): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const service =
    options.service ??
    (env.DEMO_MODE
      ? null
      : (
          await import("./perceptual-duplicates.runtime")
        ).getPerceptualDuplicatesRuntime());

  app.post(
    "/perceptual-duplicates/jobs",
    {
      preHandler: authenticateUser,
      schema: {
        tags: ["perceptual-duplicates"],
        summary: "Queue crop-aware duplicate comparison for selected videos",
        body: startPerceptualDuplicatesBodySchema,
        response: { 202: perceptualDuplicatesStartedResponseSchema },
      },
    },
    async (request, reply) => {
      if (!service) return sendDemoUnavailable(reply);
      let result: Awaited<
        ReturnType<PerceptualDuplicatesServiceContract["start"]>
      >;
      try {
        result = await service.start({
          userId: request.user!.id,
          videoIds: request.body.video_ids,
        });
      } catch (error) {
        if (isCopyEngineNotReadyError(error)) return sendEngineNotReady(reply);
        if (isRuntimeUnavailable(error)) return sendRuntimeUnavailable(reply);
        throw error;
      }
      const location = `${API_PREFIX}/perceptual-duplicates/jobs/${result.job.id}`;
      return reply
        .code(202)
        .header("Location", location)
        .send({
          success: true,
          data: { job: serializeJob(result.job), reused: result.reused },
          message: result.reused
            ? "Equivalent perceptual duplicate comparison reused"
            : "Perceptual duplicate comparison queued",
        });
    }
  );

  app.get(
    "/perceptual-duplicates/jobs/:id",
    {
      preHandler: authenticateUser,
      schema: {
        tags: ["perceptual-duplicates"],
        summary: "Inspect a perceptual duplicate comparison job",
        params: perceptualDuplicatesJobIdParamsSchema,
        response: { 200: perceptualDuplicatesJobResponseSchema },
      },
    },
    async (request, reply) => {
      if (!service) return sendDemoUnavailable(reply);
      const job = await service.get(request.params.id, request.user!.id);
      return reply.send({ success: true, data: serializeJob(job) });
    }
  );

  app.delete(
    "/perceptual-duplicates/jobs/:id",
    {
      preHandler: authenticateUser,
      schema: {
        tags: ["perceptual-duplicates"],
        summary: "Cancel a perceptual duplicate comparison job",
        params: perceptualDuplicatesJobIdParamsSchema,
        response: { 200: perceptualDuplicatesJobResponseSchema },
      },
    },
    async (request, reply) => {
      if (!service) return sendDemoUnavailable(reply);
      const job = await service.cancel(request.params.id, request.user!.id);
      return reply.send({ success: true, data: serializeJob(job) });
    }
  );
}
