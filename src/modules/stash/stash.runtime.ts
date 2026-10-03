import { sql, type SQL } from "drizzle-orm";
import { db } from "@/config/drizzle";
import {
  DurableJobsService,
  DurableJobWorker,
  PostgresDurableJobStore,
  type DurableJob,
  type DurableJobHandlerContext,
} from "@/modules/durable-jobs";
import { eventsService } from "@/modules/events/events.service";
import { logger } from "@/utils/logger";
import { STASH_SYNC_JOB_KIND, stashLinkService } from "./stash-link.service";

export const IDENTIFY_JOB_KIND = "enrichment.identify";
const LEASE_MS = 10 * 60_000;

export interface StashSyncPayload {
  /** Explicit videos; omitted = every video missing a link or a pHash. */
  video_ids?: number[];
}

function createDurableJobsService(): DurableJobsService {
  return new DurableJobsService(
    new PostgresDurableJobStore({
      async execute<Row extends Record<string, unknown>>(query: SQL) {
        return Array.from(await db.execute<Row>(query)) as Row[];
      },
    })
  );
}

export async function isStashSchemaReady(): Promise<boolean> {
  try {
    await db.execute(sql`
      SELECT link.video_id, fp.video_id, run.id, item.id
      FROM stash_scene_links AS link
      LEFT JOIN video_fingerprints AS fp ON fp.video_id = link.video_id
      LEFT JOIN identify_runs AS run ON TRUE
      LEFT JOIN identify_run_items AS item ON item.run_id = run.id
      LIMIT 0
    `);
    return true;
  } catch {
    return false;
  }
}

async function handleSync(
  job: DurableJob,
  context: DurableJobHandlerContext
): Promise<void> {
  const payload = job.payload as StashSyncPayload;
  const videoIds = payload.video_ids?.length
    ? payload.video_ids
    : await stashLinkService.videosNeedingSync();
  // Resume after the last finished chunk.
  const done = job.checkpoint?.completedUnits ?? 0;
  const result = await stashLinkService.syncVideos(videoIds.slice(done), {
    signal: context.signal,
    onProgress: async (progress) => {
      await context.heartbeat();
      if (progress.stage === "link") {
        await context.checkpoint({
          stage: "link",
          completedUnits: done + progress.done,
          totalUnits: videoIds.length,
        });
      }
      eventsService.broadcast({
        type: "stash:sync",
        message: {
          job_id: job.id,
          stage: progress.stage,
          done: done + progress.done,
          total: videoIds.length,
        },
      });
    },
  });
  logger.info({ jobId: job.id, ...result, missing: result.missing.length }, "Stash sync finished");
  eventsService.broadcast({
    type: "stash:sync",
    message: { job_id: job.id, stage: "done", done: videoIds.length, total: videoIds.length, missing: result.missing.length },
  });
}

export class StashRuntime {
  readonly durableJobs = createDurableJobsService();
  private readonly worker: DurableJobWorker;

  constructor() {
    this.worker = new DurableJobWorker(this.durableJobs, {
      workerId: `stash-worker-${process.pid}`,
      leaseDurationMs: LEASE_MS,
      pollIntervalMs: 2_000,
      maxRetries: 2,
      retryDelayMs: () => 60_000,
      kinds: [STASH_SYNC_JOB_KIND, IDENTIFY_JOB_KIND],
      handlers: {
        [STASH_SYNC_JOB_KIND]: handleSync,
        [IDENTIFY_JOB_KIND]: async (job, context) => {
          const { identifyService } = await import(
            "@/modules/enrichment/enrichment.identify.service"
          );
          await identifyService.handleJob(job, context);
        },
      },
      classifyError: (error) => ({
        // Stash or the enrichment service being down is worth a retry.
        retryable:
          error instanceof Error &&
          /unavailable|timeout|ECONNREFUSED|502/i.test(error.message),
        error: {
          code: "STASH_JOB_FAILED",
          message: error instanceof Error ? error.message : "Stash job failed",
        },
      }),
    });
  }

  enqueueSync(payload: StashSyncPayload): Promise<DurableJob> {
    return this.durableJobs.enqueue({
      kind: STASH_SYNC_JOB_KIND,
      payload: payload as Record<string, unknown>,
    });
  }

  start(): Promise<void> {
    return this.worker.start();
  }

  stop(): Promise<void> {
    return this.worker.stop();
  }
}

let singleton: StashRuntime | null = null;

export function getStashRuntime(): StashRuntime {
  singleton ??= new StashRuntime();
  return singleton;
}
