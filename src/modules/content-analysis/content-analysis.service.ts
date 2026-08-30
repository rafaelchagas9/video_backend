import { SYSTEM_BOOKMARK_CATEGORY_KEYS } from "@/modules/bookmarks/bookmark-categories.constants";
import type { DurableJobsService } from "@/modules/durable-jobs";
import { BadRequestError, ForbiddenError, NotFoundError } from "@/utils/errors";
import { startContentAnalysisSchema } from "./content-analysis.schemas";
import type {
  ContentAnalysisCancellation,
  ContentAnalysisRunStore,
} from "./content-analysis.store";
import {
  assertContentAnalysisSource,
  contentAnalysisRequestDigest,
  contentAnalysisSemanticKey,
  contentAnalysisSourceFingerprint,
} from "./content-analysis.source";
import type {
  ContentAnalysisRevisions,
  ContentAnalysisRun,
  ContentAnalysisVideoSource,
  StartContentAnalysisInput,
  StartContentAnalysisResult,
} from "./content-analysis.types";

export interface ContentAnalysisServiceDependencies {
  runStore: ContentAnalysisRunStore;
  durableJobs: DurableJobsService;
  cancellation: ContentAnalysisCancellation;
  loadFreshVideoSource(
    videoId: number
  ): Promise<ContentAnalysisVideoSource | null>;
  loadCurrentRevisions(): Promise<ContentAnalysisRevisions>;
  onRunUpdated?(run: ContentAnalysisRun): void;
}

/**
 * External content-analysis interface. Sampling, providers, leases and
 * publication mechanics stay behind this three-operation seam.
 */
export class ContentAnalysisService {
  constructor(
    private readonly dependencies: ContentAnalysisServiceDependencies
  ) {}

  async start(
    input: StartContentAnalysisInput
  ): Promise<StartContentAnalysisResult> {
    const parsed = startContentAnalysisSchema.parse(input);
    const source = await this.dependencies.loadFreshVideoSource(parsed.videoId);
    if (!source) throw new NotFoundError("Video source is unavailable");
    if (
      source.durationSeconds === null ||
      !Number.isFinite(source.durationSeconds) ||
      source.durationSeconds <= 0
    ) {
      throw new BadRequestError("Video source has no finite positive duration");
    }
    assertContentAnalysisSource(source);
    const revisions = await this.dependencies.loadCurrentRevisions();
    const requestedCategories = [
      ...(parsed.categories ?? SYSTEM_BOOKMARK_CATEGORY_KEYS),
    ].sort();
    const sourceFingerprint = contentAnalysisSourceFingerprint(source);
    const semanticGenerationKey = contentAnalysisSemanticKey({
      videoId: parsed.videoId,
      userId: parsed.userId,
      kind: "nudity",
      profile: parsed.profile,
      requestedCategories,
      sourceFingerprint,
      sourceDurationSeconds: source.durationSeconds,
      ...revisions,
    });
    const requestDigest = contentAnalysisRequestDigest({
      semanticGenerationKey,
      force: parsed.force,
    });

    const result = await this.dependencies.runStore.enqueue({
      videoId: parsed.videoId,
      userId: parsed.userId,
      kind: "nudity",
      profile: parsed.profile,
      requestedCategories,
      sourceFingerprint,
      sourceDurationSeconds: source.durationSeconds,
      idempotencyKey: parsed.idempotencyKey ?? null,
      requestDigest,
      semanticGenerationKey,
      force: parsed.force,
      ...revisions,
    });
    this.dependencies.onRunUpdated?.(result.run);
    return result;
  }

  async get(runId: number, userId: number): Promise<ContentAnalysisRun> {
    const run = await this.dependencies.runStore.findById(runId);
    if (!run)
      throw new NotFoundError(`Content analysis run not found: ${runId}`);
    if (run.userId !== userId) {
      throw new ForbiddenError(
        "You do not have permission to inspect this analysis"
      );
    }
    const durable = await this.dependencies.durableJobs.get(run.durableJobId);
    if (!durable) return run;
    return {
      ...run,
      status: durable.status,
      retryCount: durable.retryCount,
      errorCode: durable.lastError?.code ?? run.errorCode,
      errorMessage: durable.lastError?.message ?? run.errorMessage,
      cancelledAt: durable.cancelledAt ?? run.cancelledAt,
      completedAt: durable.completedAt ?? run.completedAt,
      phase:
        durable.status === "cancelled"
          ? "cancelled"
          : durable.status === "failed"
            ? "failed"
            : durable.status === "completed"
              ? "completed"
              : run.phase,
    };
  }

  async cancel(runId: number, userId: number): Promise<ContentAnalysisRun> {
    const existing = await this.dependencies.runStore.findById(runId);
    if (!existing) {
      throw new NotFoundError(`Content analysis run not found: ${runId}`);
    }
    if (existing.userId !== userId) {
      throw new ForbiddenError(
        "You do not have permission to cancel this analysis"
      );
    }
    const cancelled = await this.dependencies.runStore.cancel(runId, userId);
    if (cancelled?.status === "cancelled") {
      this.dependencies.cancellation.cancelActive(
        cancelled.durableJobId,
        new Error("Content analysis cancelled")
      );
    }
    if (!cancelled) {
      throw new NotFoundError(`Content analysis run not found: ${runId}`);
    }
    this.dependencies.onRunUpdated?.(cancelled);
    return cancelled;
  }
}
