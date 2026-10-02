import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { API_PREFIX } from "@/config/constants";
import { env } from "@/config/env";
import { authenticateUser } from "@/modules/auth/auth.middleware";
import {
  COPY_ENGINE_NOT_READY_CODE,
  COPY_ENGINE_NOT_READY_REASON,
  isCopyEngineNotReadyError,
} from "@/modules/copy-detection/copy-detection.readiness";
import {
  librarySyncOverviewResponseSchema,
  librarySyncPerceptualResultsResponseSchema,
  librarySyncResultsQuerySchema,
  librarySyncRunIdParamsSchema,
  librarySyncRunResponseSchema,
  librarySyncSettingsBodySchema,
  librarySyncSettingsResponseSchema,
  librarySyncStartedResponseSchema,
  librarySyncStartBodySchema,
} from "./library-sync.schemas";
import type {
  LibrarySyncRun,
  LibrarySyncServiceContract,
} from "./library-sync.types";

export interface LibrarySyncRoutesOptions {
  service?: LibrarySyncServiceContract | null;
}
function unavailable(reply: FastifyReply) {
  return reply.code(503).send({
    success: false,
    error: {
      code: "LIBRARY_SYNC_UNAVAILABLE_IN_DEMO",
      message: "Library synchronization is unavailable in demo mode",
      statusCode: 503,
    },
  });
}
/** Demo mode has no sync runtime, but its overview is read-only: answer it
 * with an idle backlog (every demo video already processed) so the page reads
 * as a quiet state rather than an outage. Starting a run still 503s. */
async function demoOverview() {
  const { count } = await import("drizzle-orm");
  const { getDemoDatabase } = await import("@/database/demo/client");
  const { demoVideosTable } = await import("@/database/demo/schema");
  const total =
    getDemoDatabase().select({ total: count() }).from(demoVideosTable).get()
      ?.total ?? 0;
  const done = { pending: 0, completed: total };
  return {
    generation: "demo",
    capabilities: {
      perceptual: {
        enabled: false,
        code: null,
        reason: "Library synchronization is unavailable in demo mode",
      },
    },
    settings: { auto_perceptual: false },
    counts: {
      total_videos: total,
      tasks: { perceptual: done, faces: done, storyboards: done, previews: done },
    },
    active_run: null,
    recent_runs: [],
  };
}
function engineNotReady(reply: FastifyReply) {
  return reply.code(503).send({
    success: false,
    error: {
      code: COPY_ENGINE_NOT_READY_CODE,
      message: COPY_ENGINE_NOT_READY_REASON,
      statusCode: 503,
    },
  });
}
function serialize(run: LibrarySyncRun) {
  return {
    id: run.id,
    generation: run.generation,
    tasks: run.tasks,
    trigger: run.trigger,
    status: run.status,
    phase: run.phase,
    progress: {
      total: run.progress.total,
      processed: run.progress.processed,
      completed: run.progress.completed,
      failed: run.progress.failed,
      skipped: run.progress.skipped,
      pending: run.progress.pending,
      current: run.progress.current
        ? {
            task: run.progress.current.task,
            video_id: run.progress.current.videoId,
          }
        : null,
      by_task: {
        perceptual: run.progress.byTask.perceptual,
        faces: run.progress.byTask.faces,
        storyboards: run.progress.byTask.storyboards,
        // Runs recorded before the previews task existed carry no entry for it.
        previews: run.progress.byTask.previews ?? {
          total: 0,
          processed: 0,
          completed: 0,
          failed: 0,
          skipped: 0,
          pending: 0,
        },
      },
    },
    matching: run.matching,
    recent_items: run.recentItems.map((item) => ({
      task: item.task,
      video_id: item.videoId,
      status: item.status,
      result: item.result,
      error: item.error,
    })),
    error: run.error,
    retry_count: run.retryCount,
    created_at: run.createdAt.toISOString(),
    updated_at: run.updatedAt.toISOString(),
    started_at: run.startedAt?.toISOString() ?? null,
    completed_at: run.completedAt?.toISOString() ?? null,
    cancelled_at: run.cancelledAt?.toISOString() ?? null,
  };
}
export async function librarySyncRoutes(
  fastify: FastifyInstance,
  options: LibrarySyncRoutesOptions = {}
) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const service =
    options.service !== undefined
      ? options.service
      : env.DEMO_MODE
        ? null
        : (await import("./library-sync.runtime")).getLibrarySyncRuntime();
  app.get(
    "/library-sync",
    {
      preHandler: authenticateUser,
      schema: {
        tags: ["library-sync"],
        summary: "Inspect library maintenance backlog",
        response: { 200: librarySyncOverviewResponseSchema },
      },
    },
    async (_request, reply) => {
      if (!service) {
        if (!env.DEMO_MODE) return unavailable(reply);
        return reply.send({ success: true, data: await demoOverview() });
      }
      const data = await service.overview();
      return reply.send({
        success: true,
        data: {
          generation: data.generation,
          capabilities: data.capabilities,
          settings: { auto_perceptual: data.settings.autoPerceptual },
          counts: {
            total_videos: data.counts.totalVideos,
            tasks: data.counts.tasks,
          },
          active_run: data.activeRun ? serialize(data.activeRun) : null,
          recent_runs: data.recentRuns.map(serialize),
        },
      });
    }
  );
  app.post(
    "/library-sync/runs",
    {
      preHandler: authenticateUser,
      schema: {
        tags: ["library-sync"],
        summary: "Queue selected library maintenance tasks",
        body: librarySyncStartBodySchema,
        response: { 202: librarySyncStartedResponseSchema },
      },
    },
    async (request, reply) => {
      if (!service) return unavailable(reply);
      let result: Awaited<ReturnType<LibrarySyncServiceContract["startRun"]>>;
      try {
        result = await service.startRun({
          tasks: request.body.tasks,
          userId: request.user!.id,
        });
      } catch (error) {
        if (isCopyEngineNotReadyError(error)) return engineNotReady(reply);
        throw error;
      }
      return reply
        .code(202)
        .header("Location", `${API_PREFIX}/library-sync/runs/${result.run.id}`)
        .send({
          success: true,
          data: { run: serialize(result.run), reused: result.reused },
        });
    }
  );
  app.get(
    "/library-sync/runs/:id",
    {
      preHandler: authenticateUser,
      schema: {
        tags: ["library-sync"],
        summary: "Inspect a library maintenance run",
        params: librarySyncRunIdParamsSchema,
        response: { 200: librarySyncRunResponseSchema },
      },
    },
    async (request, reply) => {
      if (!service) return unavailable(reply);
      return reply.send({
        success: true,
        data: serialize(await service.getRun(request.params.id)),
      });
    }
  );
  app.delete(
    "/library-sync/runs/:id",
    {
      preHandler: authenticateUser,
      schema: {
        tags: ["library-sync"],
        summary: "Cancel a library maintenance run",
        params: librarySyncRunIdParamsSchema,
        response: { 200: librarySyncRunResponseSchema },
      },
    },
    async (request, reply) => {
      if (!service) return unavailable(reply);
      return reply.send({
        success: true,
        data: serialize(await service.cancelRun(request.params.id)),
      });
    }
  );
  app.patch(
    "/library-sync/settings",
    {
      preHandler: authenticateUser,
      schema: {
        tags: ["library-sync"],
        summary: "Update automatic library maintenance",
        body: librarySyncSettingsBodySchema,
        response: { 200: librarySyncSettingsResponseSchema },
      },
    },
    async (request, reply) => {
      if (!service) return unavailable(reply);
      let data: Awaited<ReturnType<LibrarySyncServiceContract["updateSettings"]>>;
      try {
        data = await service.updateSettings({
          autoPerceptual: request.body.auto_perceptual,
        });
      } catch (error) {
        if (isCopyEngineNotReadyError(error)) return engineNotReady(reply);
        throw error;
      }
      return reply.send({
        success: true,
        data: { auto_perceptual: data.autoPerceptual },
      });
    }
  );
  app.get(
    "/library-sync/perceptual-results",
    {
      preHandler: authenticateUser,
      schema: {
        tags: ["library-sync"],
        summary: "List perceptual duplicate results",
        querystring: librarySyncResultsQuerySchema,
        response: { 200: librarySyncPerceptualResultsResponseSchema },
      },
    },
    async (request, reply) => {
      if (!service) {
        if (!env.DEMO_MODE) return unavailable(reply);
        const { demoCopyResults } = await import("./library-sync.demo.service");
        return reply.send({
          success: true,
          data: demoCopyResults(request.query),
        });
      }
      return reply.send({
        success: true,
        data: await service.perceptualResults(request.query),
      });
    }
  );
}
