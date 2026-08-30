import type {
  DurableJob,
  DurableJobErrorClassification,
  DurableJobHandlerContext,
} from "@/modules/durable-jobs";
import { logger } from "@/utils/logger";
import { contentAnalysisJobPayloadSchema } from "./content-analysis.schemas";
import { contentAnalysisCheckpointSchema } from "./content-analysis.schemas";
import {
  ContentAnalysisAnalyzerChangedError,
  ContentAnalysisLeaseLostError,
  ContentAnalysisSourceChangedError,
  RetryableContentAnalysisError,
  type ContentAnalysisCancellation,
  type ContentAnalysisRunStore,
} from "./content-analysis.store";
import {
  assertContentAnalysisSource,
  sourceMatchesRun,
} from "./content-analysis.source";
import type {
  ContentAnalysisProcessor,
  ContentAnalysisProgress,
  ContentAnalysisRevisions,
  ContentAnalysisRun,
  ContentAnalysisVideoSource,
} from "./content-analysis.types";
import {
  assertContentAnalysisEvents,
  assertContentAnalysisProgress,
  CONTENT_ANALYSIS_ACTIVE_PHASE_ORDER,
} from "./content-analysis.validation";

export interface ContentAnalysisHandlerDependencies {
  runStore: ContentAnalysisRunStore;
  loadFreshVideoSource(
    videoId: number
  ): Promise<ContentAnalysisVideoSource | null>;
  loadCurrentRevisions(): Promise<ContentAnalysisRevisions>;
  processor: ContentAnalysisProcessor;
  maxRetries?: number;
  retryDelayMs?: number;
  onRunUpdated?(run: ContentAnalysisRun): void;
}

export class ContentAnalysisHandler implements ContentAnalysisCancellation {
  private readonly activeControllers = new Map<number, AbortController>();
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;

  constructor(
    private readonly dependencies: ContentAnalysisHandlerDependencies
  ) {
    this.maxRetries = dependencies.maxRetries ?? 3;
    this.retryDelayMs = dependencies.retryDelayMs ?? 1_000;
  }

  cancelActive(durableJobId: number, reason?: unknown): void {
    this.activeControllers.get(durableJobId)?.abort(reason);
  }

  async handle(
    job: DurableJob,
    context: DurableJobHandlerContext
  ): Promise<void> {
    const { runId } = contentAnalysisJobPayloadSchema.parse(job.payload);
    if (!job.leaseToken) throw new ContentAnalysisLeaseLostError();
    const run = await this.dependencies.runStore.findByDurableJobId(job.id);
    if (!run || run.id !== runId) {
      throw new Error(
        `Content analysis run not found for durable job ${job.id}`
      );
    }
    if (run.isPublished && run.status === "completed") return;
    if (job.attempt > this.maxRetries + 1) {
      const exhausted = await this.dependencies.runStore.recordError(
        run.id,
        { durableJobId: job.id, leaseToken: job.leaseToken },
        {
          status: "failed",
          code: "CONTENT_ANALYSIS_ATTEMPT_LIMIT",
          message: "Content analysis exceeded its crash/retry attempt budget",
          retryCount: job.retryCount,
          retryDelayMs: this.retryDelayMs,
        }
      );
      if (!exhausted) throw new ContentAnalysisLeaseLostError();
      this.dependencies.onRunUpdated?.(exhausted);
      return;
    }
    const localController = new AbortController();
    this.activeControllers.set(job.id, localController);
    const signal = AbortSignal.any([context.signal, localController.signal]);
    const lease = { durableJobId: job.id, leaseToken: job.leaseToken };
    try {
      const resumeCheckpoint = job.checkpoint
        ? contentAnalysisCheckpointSchema.parse(job.checkpoint).data
        : null;
      if (
        resumeCheckpoint &&
        resumeCheckpoint.scannedSeconds > run.sourceDurationSeconds
      ) {
        throw new Error("Invalid content analysis checkpoint");
      }
      const source = await this.dependencies.loadFreshVideoSource(run.videoId);
      assertContentAnalysisSource(source);
      if (!sourceMatchesRun(source, run)) {
        throw new ContentAnalysisSourceChangedError();
      }
      this.assertRevisions(run, await this.dependencies.loadCurrentRevisions());
      const initialPhase = resumeCheckpoint?.phase ?? this.activeRunPhase(run);
      const started = await this.dependencies.runStore.updateProgress(
        run.id,
        lease,
        {
          phase: initialPhase,
          scannedSeconds:
            resumeCheckpoint?.scannedSeconds ?? run.scannedSeconds,
          sampledFrames: resumeCheckpoint?.sampledFrames ?? run.sampledFrames,
          positiveFrames:
            resumeCheckpoint?.positiveFrames ?? run.positiveFrames,
          ...(resumeCheckpoint?.cursor
            ? { cursor: resumeCheckpoint.cursor }
            : {}),
        }
      );
      if (!started) throw new ContentAnalysisLeaseLostError();
      this.dependencies.onRunUpdated?.(started);
      let latestProgress: ContentAnalysisProgress = {
        phase: initialPhase,
        scannedSeconds: started.scannedSeconds,
        sampledFrames: started.sampledFrames,
        positiveFrames: started.positiveFrames,
        ...(resumeCheckpoint?.cursor
          ? { cursor: resumeCheckpoint.cursor }
          : {}),
      };

      const result = await this.dependencies.processor(started, {
        signal,
        resumeCheckpoint,
        checkpoint: async (progress) => {
          if (signal.aborted) throw signal.reason;
          assertContentAnalysisProgress(
            progress,
            run.sourceDurationSeconds,
            latestProgress
          );
          const updated = await this.dependencies.runStore.updateProgress(
            run.id,
            lease,
            progress
          );
          if (!updated) throw new ContentAnalysisLeaseLostError();
          this.dependencies.onRunUpdated?.(updated);
          latestProgress = structuredClone(progress);
        },
        stageObservationChunk: async (chunk) => {
          if (signal.aborted) throw signal.reason;
          const staged = await this.dependencies.runStore.stageObservationChunk(
            run.id,
            lease,
            chunk
          );
          if (!staged) throw new ContentAnalysisLeaseLostError();
        },
        loadObservationChunks: () =>
          this.dependencies.runStore.listObservationChunks(run.id),
      });
      if (signal.aborted) throw signal.reason;
      assertContentAnalysisEvents(result.events, run);
      const publishing = await this.dependencies.runStore.updateProgress(
        run.id,
        lease,
        {
          phase: "publishing",
          scannedSeconds: run.sourceDurationSeconds,
          sampledFrames: latestProgress.sampledFrames,
          positiveFrames: latestProgress.positiveFrames,
        }
      );
      if (!publishing) throw new ContentAnalysisLeaseLostError();
      this.dependencies.onRunUpdated?.(publishing);

      const currentSource = await this.dependencies.loadFreshVideoSource(
        run.videoId
      );
      assertContentAnalysisSource(currentSource);
      if (!sourceMatchesRun(currentSource, run)) {
        throw new ContentAnalysisSourceChangedError();
      }
      this.assertRevisions(run, await this.dependencies.loadCurrentRevisions());
      const published = await this.dependencies.runStore.publish({
        runId: run.id,
        lease,
        source: currentSource,
        events: result.events,
      });
      if (!published) throw new ContentAnalysisLeaseLostError();
      this.dependencies.onRunUpdated?.(published);
    } catch (error) {
      if (localController.signal.aborted) return;
      if (signal.aborted || error instanceof ContentAnalysisLeaseLostError) {
        throw error;
      }
      const classification = this.classifyError(error);
      const willRetry =
        classification.retryable && job.retryCount < this.maxRetries;
      const recorded = await this.dependencies.runStore.recordError(
        run.id,
        lease,
        {
          status: willRetry ? "retry_wait" : "failed",
          code: classification.error.code,
          message: classification.error.message,
          retryCount: job.retryCount + (willRetry ? 1 : 0),
          retryDelayMs: this.retryDelayMs,
        }
      );
      if (!recorded) throw new ContentAnalysisLeaseLostError();
      this.dependencies.onRunUpdated?.(recorded);
      return;
    } finally {
      if (this.activeControllers.get(job.id) === localController) {
        this.activeControllers.delete(job.id);
      }
    }
  }

  classifyError(error: unknown): DurableJobErrorClassification {
    if (error instanceof RetryableContentAnalysisError) {
      return {
        retryable: true,
        error: { code: error.code, message: error.message },
      };
    }
    if (error instanceof ContentAnalysisSourceChangedError) {
      return {
        retryable: false,
        error: { code: error.code, message: error.message },
      };
    }
    if (error instanceof ContentAnalysisAnalyzerChangedError) {
      return {
        retryable: false,
        error: { code: error.code, message: error.message },
      };
    }
    logger.error({ error }, "Unexpected content analysis failure");
    return {
      retryable: false,
      error: {
        code: "CONTENT_ANALYSIS_FAILED",
        message: "Content analysis failed",
      },
    };
  }

  private assertRevisions(
    run: ContentAnalysisRevisions,
    current: ContentAnalysisRevisions
  ): void {
    if (
      run.analyzerRevision !== current.analyzerRevision ||
      run.modelRevision !== current.modelRevision ||
      run.taxonomyRevision !== current.taxonomyRevision ||
      run.configRevision !== current.configRevision
    ) {
      throw new ContentAnalysisAnalyzerChangedError();
    }
  }

  private activeRunPhase(
    run: ContentAnalysisRun
  ): ContentAnalysisProgress["phase"] {
    if (run.phase === "queued") return "extracting";
    if (
      (CONTENT_ANALYSIS_ACTIVE_PHASE_ORDER as readonly string[]).includes(
        run.phase
      )
    ) {
      return run.phase as ContentAnalysisProgress["phase"];
    }
    throw new Error(`Content analysis run ${run.id} is not active`);
  }
}
