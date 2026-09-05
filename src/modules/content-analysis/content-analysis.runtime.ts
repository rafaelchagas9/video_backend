import { eq, sql, type SQL } from "drizzle-orm";
import { db } from "@/config/drizzle";
import { env } from "@/config/env";
import { videosTable } from "@/database/schema";
import {
  DurableJobsService,
  DurableJobWorker,
  PostgresDurableJobStore,
} from "@/modules/durable-jobs";
import { eventsService } from "@/modules/events/events.service";
import {
  NudityContentAnalysisProcessor,
  DEFAULT_NUDITY_PROCESSOR_CONFIG,
} from "./content-analysis.processor";
import { ContentAnalysisHandler } from "./content-analysis.handler";
import { PostgresContentAnalysisRunStore } from "./content-analysis.postgres.store";
import { ContentAnalysisService } from "./content-analysis.service";
import {
  FileContentAnalysisSourceResolver,
  type ContentAnalysisSourceCandidate,
} from "./content-analysis.source-resolver";
import { PtsAwareChunkExtractor } from "./content-analysis.pts-extractor";
import { HttpVisualInferenceAdapter } from "./visual-inference.http.adapter";
import type { ContentAnalysisRun } from "./content-analysis.types";
import { contentAnalysisRevisionsFromCapabilities } from "./content-analysis.revisions";

const CONTENT_ANALYSIS_JOB_KIND = "vision.content-analysis";
function createDurableJobsService(): DurableJobsService {
  return new DurableJobsService(
    new PostgresDurableJobStore({
      async execute<Row extends Record<string, unknown>>(query: SQL) {
        return Array.from(await db.execute<Row>(query)) as Row[];
      },
    })
  );
}

function publicRunUpdate(run: ContentAnalysisRun): void {
  eventsService.broadcastToUser(run.userId, {
    type: "content-analysis:updated",
    message: {
      id: run.id,
      video_id: run.videoId,
      status: run.status,
      phase: run.phase,
      scanned_seconds: run.scannedSeconds,
      source_duration_seconds: run.sourceDurationSeconds,
      sampled_frames: run.sampledFrames,
      positive_frames: run.positiveFrames,
      result_bookmark_count: run.resultBookmarkCount,
      error_code: run.errorCode,
    },
  });
}

export async function isContentAnalysisSchemaReady(): Promise<boolean> {
  try {
    await db.execute(sql`
      SELECT run.id, observation.run_id
      FROM content_analysis_runs AS run
      LEFT JOIN content_analysis_observation_chunks AS observation
        ON observation.run_id = run.id
      LIMIT 0
    `);
    return true;
  } catch {
    return false;
  }
}

export class ContentAnalysisRuntime {
  readonly service: ContentAnalysisService;
  private readonly worker: DurableJobWorker;

  constructor() {
    const runStore = new PostgresContentAnalysisRunStore(db);
    const durableJobs = createDurableJobsService();
    const sourceResolver = new FileContentAnalysisSourceResolver({
      ffprobePath: env.FFPROBE_PATH,
      timeoutMs: env.CONTENT_ANALYSIS_PROBE_TIMEOUT_MS,
    });
    const inference = new HttpVisualInferenceAdapter({
      baseUrl: env.VISION_SERVICE_URL,
      internalSecret: env.VISION_SERVICE_SECRET,
      timeoutMs: env.CONTENT_ANALYSIS_VISION_TIMEOUT_MS,
    });
    const loadSourceCandidate = async (
      videoId: number
    ): Promise<ContentAnalysisSourceCandidate | null> => {
      const [video] = await db
        .select({ id: videosTable.id, filePath: videosTable.filePath })
        .from(videosTable)
        .where(eq(videosTable.id, videoId))
        .limit(1);
      return video ?? null;
    };
    const loadFreshVideoSource = async (videoId: number) => {
      const candidate = await loadSourceCandidate(videoId);
      return candidate ? sourceResolver.resolve(candidate) : null;
    };
    const loadCurrentRevisions = async () =>
      contentAnalysisRevisionsFromCapabilities(await inference.capabilities());
    const processor = new NudityContentAnalysisProcessor({
      config: {
        ...DEFAULT_NUDITY_PROCESSOR_CONFIG,
        refinementCacheMaxBytes:
          env.CONTENT_ANALYSIS_REFINEMENT_CACHE_MB * 1024 * 1024,
      },
      sourceResolver,
      loadSourceCandidate,
      extractor: new PtsAwareChunkExtractor({
        ffmpegPath: env.FFMPEG_PATH,
        temporaryRoot: env.FRAME_EXTRACTION_TEMP_DIR,
        timeoutMs: env.CONTENT_ANALYSIS_EXTRACTION_TIMEOUT_MS,
        hardwareAcceleration: {
          type: "vaapi",
          device: env.VAAPI_DEVICE,
        },
        outputFormat: "jpg",
        jpegQuality: 5,
      }),
      inference,
    });
    const handler = new ContentAnalysisHandler({
      runStore,
      loadFreshVideoSource,
      loadCurrentRevisions,
      processor: processor.process,
      maxRetries: env.CONTENT_ANALYSIS_MAX_RETRIES,
      retryDelayMs: env.CONTENT_ANALYSIS_RETRY_DELAY_MS,
      onRunUpdated: publicRunUpdate,
    });
    this.service = new ContentAnalysisService({
      runStore,
      durableJobs,
      cancellation: handler,
      loadFreshVideoSource,
      loadCurrentRevisions,
      onRunUpdated: publicRunUpdate,
    });
    this.worker = new DurableJobWorker(durableJobs, {
      workerId: `content-analysis-worker-${process.pid}`,
      leaseDurationMs: env.CONTENT_ANALYSIS_LEASE_MS,
      heartbeatIntervalMs: Math.floor(env.CONTENT_ANALYSIS_LEASE_MS / 3),
      pollIntervalMs: 1_000,
      maxRetries: env.CONTENT_ANALYSIS_MAX_RETRIES,
      retryDelayMs: () => env.CONTENT_ANALYSIS_RETRY_DELAY_MS,
      stopGracePeriodMs: 10_000,
      kinds: [CONTENT_ANALYSIS_JOB_KIND],
      handlers: {
        [CONTENT_ANALYSIS_JOB_KIND]: (job, context) =>
          handler.handle(job, context),
      },
      classifyError: (error) => handler.classifyError(error),
    });
  }

  start(): Promise<void> {
    return this.worker.start();
  }

  stop(): Promise<void> {
    return this.worker.stop();
  }
}

let singleton: ContentAnalysisRuntime | null = null;

export function getContentAnalysisRuntime(): ContentAnalysisRuntime {
  singleton ??= new ContentAnalysisRuntime();
  return singleton;
}
