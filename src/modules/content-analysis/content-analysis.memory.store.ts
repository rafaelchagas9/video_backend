import type { DurableJobsService } from "@/modules/durable-jobs";
import {
  ContentAnalysisIdempotencyConflictError,
  type ContentAnalysisRunStore,
} from "./content-analysis.store";
import { contentAnalysisCheckpointSchema } from "./content-analysis.schemas";
import { sourceMatchesRun } from "./content-analysis.source";
import type {
  ContentAnalysisEvent,
  ContentAnalysisIntent,
  ContentAnalysisLease,
  ContentAnalysisObservationChunk,
  ContentAnalysisProgress,
  ContentAnalysisRun,
} from "./content-analysis.types";
import {
  assertContentAnalysisProgress,
  assertContentAnalysisObservationChunk,
  CONTENT_ANALYSIS_ACTIVE_PHASE_ORDER,
} from "./content-analysis.validation";

export interface InMemoryContentAnalysisRunStoreOptions {
  now?: () => Date;
}

export class InMemoryContentAnalysisRunStore implements ContentAnalysisRunStore {
  private readonly now: () => Date;
  private readonly runs = new Map<number, ContentAnalysisRun>();
  private readonly events = new Map<number, ContentAnalysisEvent[]>();
  private readonly observationChunks = new Map<
    number,
    Map<string, ContentAnalysisObservationChunk>
  >();
  private nextRunId = 1;
  private nextEventId = 1;

  constructor(
    private readonly durableJobs: DurableJobsService,
    options: InMemoryContentAnalysisRunStoreOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async enqueue(
    intent: ContentAnalysisIntent
  ): Promise<{ run: ContentAnalysisRun; reused: boolean }> {
    if (intent.idempotencyKey) {
      const existing = [...this.runs.values()].find(
        (run) =>
          run.userId === intent.userId &&
          run.idempotencyKey === intent.idempotencyKey
      );
      if (existing) {
        if (existing.requestDigest !== intent.requestDigest) {
          throw new ContentAnalysisIdempotencyConflictError();
        }
        return { run: this.cloneRun(existing), reused: true };
      }
    }

    const equivalent = [...this.runs.values()]
      .filter(
        (run) =>
          run.semanticGenerationKey === intent.semanticGenerationKey &&
          ["queued", "running", "retry_wait", "completed"].includes(run.status)
      )
      .sort((left, right) => right.id - left.id);
    const active = equivalent.find((run) => run.status !== "completed");
    if (active) return { run: this.cloneRun(active), reused: true };
    if (!intent.force && equivalent[0]) {
      return { run: this.cloneRun(equivalent[0]), reused: true };
    }

    const id = this.nextRunId++;
    const durableJob = await this.durableJobs.enqueue({
      kind: "vision.content-analysis",
      payload: { runId: id },
    });
    const now = this.now();
    const run: ContentAnalysisRun = {
      id,
      durableJobId: durableJob.id,
      videoId: intent.videoId,
      userId: intent.userId,
      kind: intent.kind,
      profile: intent.profile,
      requestedCategories: [...intent.requestedCategories],
      status: "queued",
      phase: "queued",
      scannedSeconds: 0,
      sourceDurationSeconds: intent.sourceDurationSeconds,
      sampledFrames: 0,
      positiveFrames: 0,
      sourceFingerprint: intent.sourceFingerprint,
      analyzerRevision: intent.analyzerRevision,
      modelRevision: intent.modelRevision,
      taxonomyRevision: intent.taxonomyRevision,
      configRevision: intent.configRevision,
      idempotencyKey: intent.idempotencyKey,
      requestDigest: intent.requestDigest,
      semanticGenerationKey: intent.semanticGenerationKey,
      resultEventCount: 0,
      resultBookmarkCount: 0,
      errorCode: null,
      errorMessage: null,
      retryCount: 0,
      isPublished: false,
      publishedAt: null,
      startedAt: null,
      completedAt: null,
      cancelledAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.runs.set(run.id, run);
    return { run: this.cloneRun(run), reused: false };
  }

  async findById(runId: number): Promise<ContentAnalysisRun | null> {
    const run = this.runs.get(runId);
    return run ? this.cloneRun(run) : null;
  }

  async findByDurableJobId(
    durableJobId: number
  ): Promise<ContentAnalysisRun | null> {
    const run = [...this.runs.values()].find(
      (candidate) => candidate.durableJobId === durableJobId
    );
    return run ? this.cloneRun(run) : null;
  }

  async stageObservationChunk(
    runId: number,
    lease: ContentAnalysisLease,
    chunk: ContentAnalysisObservationChunk
  ): Promise<boolean> {
    const run = this.runs.get(runId);
    if (
      !run ||
      run.durableJobId !== lease.durableJobId ||
      !(await this.hasActiveLease(lease))
    ) {
      return false;
    }
    assertContentAnalysisObservationChunk(chunk, run);
    const chunks = this.observationChunks.get(runId) ?? new Map();
    chunks.set(`${chunk.phase}:${chunk.chunkIndex}`, structuredClone(chunk));
    this.observationChunks.set(runId, chunks);
    return true;
  }

  async listObservationChunks(
    runId: number
  ): Promise<ContentAnalysisObservationChunk[]> {
    return [...(this.observationChunks.get(runId)?.values() ?? [])]
      .sort(
        (left, right) =>
          (left.phase === right.phase ? 0 : left.phase === "coarse" ? -1 : 1) ||
          left.chunkIndex - right.chunkIndex
      )
      .map((chunk) => structuredClone(chunk));
  }

  async updateProgress(
    runId: number,
    lease: ContentAnalysisLease,
    progress: ContentAnalysisProgress
  ): Promise<ContentAnalysisRun | null> {
    const run = this.runs.get(runId);
    const durable = await this.durableJobs.get(lease.durableJobId);
    if (
      !run ||
      run.durableJobId !== lease.durableJobId ||
      !durable ||
      durable.status !== "running" ||
      durable.leaseToken !== lease.leaseToken ||
      !durable.leaseExpiresAt ||
      durable.leaseExpiresAt <= this.now()
    ) {
      return null;
    }
    const parsedCheckpoint = durable.checkpoint
      ? contentAnalysisCheckpointSchema.parse(durable.checkpoint).data
      : null;
    const currentPhase = CONTENT_ANALYSIS_ACTIVE_PHASE_ORDER.includes(
      run.phase as (typeof CONTENT_ANALYSIS_ACTIVE_PHASE_ORDER)[number]
    )
      ? (run.phase as ContentAnalysisProgress["phase"])
      : "extracting";
    assertContentAnalysisProgress(progress, run.sourceDurationSeconds, {
      ...(parsedCheckpoint ?? {
        phase: currentPhase,
        scannedSeconds: run.scannedSeconds,
        sampledFrames: run.sampledFrames,
        positiveFrames: run.positiveFrames,
      }),
    });
    const durableCheckpoint = await this.durableJobs.checkpoint({
      jobId: lease.durableJobId,
      leaseToken: lease.leaseToken,
      checkpoint: {
        stage: progress.phase,
        completedUnits: progress.scannedSeconds,
        totalUnits: run.sourceDurationSeconds,
        data: {
          version: 1,
          phase: progress.phase,
          scannedSeconds: progress.scannedSeconds,
          sampledFrames: progress.sampledFrames,
          positiveFrames: progress.positiveFrames,
          ...(progress.cursor ? { cursor: progress.cursor } : {}),
        },
      },
    });
    if (!durableCheckpoint) return null;
    const now = this.now();
    Object.assign(run, {
      status: "running" as const,
      phase: progress.phase,
      scannedSeconds: Math.max(run.scannedSeconds, progress.scannedSeconds),
      sampledFrames: Math.max(run.sampledFrames, progress.sampledFrames),
      positiveFrames: Math.max(run.positiveFrames, progress.positiveFrames),
      startedAt: run.startedAt ?? now,
      updatedAt: now,
      errorCode: null,
      errorMessage: null,
    });
    return this.cloneRun(run);
  }

  async recordError(
    runId: number,
    lease: ContentAnalysisLease,
    input: {
      status: "retry_wait" | "failed";
      code: string;
      message: string;
      retryCount: number;
      retryDelayMs: number;
    }
  ): Promise<ContentAnalysisRun | null> {
    const run = this.runs.get(runId);
    if (
      !run ||
      run.durableJobId !== lease.durableJobId ||
      !(await this.hasActiveLease(lease))
    ) {
      return null;
    }
    const transitioned =
      input.status === "retry_wait"
        ? await this.durableJobs.retryAfter({
            jobId: lease.durableJobId,
            leaseToken: lease.leaseToken,
            error: { code: input.code, message: input.message },
            delayMs: input.retryDelayMs,
          })
        : await this.durableJobs.fail({
            jobId: lease.durableJobId,
            leaseToken: lease.leaseToken,
            error: { code: input.code, message: input.message },
          });
    if (!transitioned) return null;
    const now = this.now();
    Object.assign(run, {
      status: input.status,
      phase: input.status === "failed" ? ("failed" as const) : run.phase,
      errorCode: input.code,
      errorMessage: input.message,
      retryCount: input.retryCount,
      completedAt: input.status === "failed" ? now : null,
      updatedAt: now,
    });
    return this.cloneRun(run);
  }

  async cancel(
    runId: number,
    userId: number
  ): Promise<ContentAnalysisRun | null> {
    const run = this.runs.get(runId);
    if (!run || run.userId !== userId) return null;
    if (["completed", "failed", "cancelled"].includes(run.status)) {
      return this.cloneRun(run);
    }
    const cancelled = await this.durableJobs.requestCancellation(
      run.durableJobId
    );
    if (cancelled?.status !== "cancelled") return this.cloneRun(run);
    const now = this.now();
    Object.assign(run, {
      status: "cancelled" as const,
      phase: "cancelled" as const,
      cancelledAt: now,
      completedAt: now,
      updatedAt: now,
    });
    return this.cloneRun(run);
  }

  async publish(input: {
    runId: number;
    lease: ContentAnalysisLease;
    source: import("./content-analysis.types").ContentAnalysisVideoSource;
    events: import("./content-analysis.types").ContentAnalysisEventDraft[];
  }): Promise<ContentAnalysisRun | null> {
    const run = this.runs.get(input.runId);
    if (!run || run.durableJobId !== input.lease.durableJobId) return null;
    if (run.isPublished && run.status === "completed") {
      return this.cloneRun(run);
    }
    if (!sourceMatchesRun(input.source, run)) return null;
    const completed = await this.durableJobs.complete({
      jobId: input.lease.durableJobId,
      leaseToken: input.lease.leaseToken,
    });
    if (!completed) return null;

    for (const candidate of this.runs.values()) {
      if (
        candidate.id !== run.id &&
        candidate.videoId === run.videoId &&
        candidate.userId === run.userId &&
        candidate.kind === run.kind
      ) {
        candidate.isPublished = false;
      }
    }
    for (const [candidateRunId, generation] of this.events) {
      const candidate = this.runs.get(candidateRunId);
      if (
        candidate &&
        candidate.videoId === run.videoId &&
        candidate.userId === run.userId &&
        candidate.kind === run.kind
      ) {
        for (const event of generation) event.isPublished = false;
      }
    }
    const now = this.now();
    const events = input.events.map<ContentAnalysisEvent>((event) => ({
      ...structuredClone(event),
      id: this.nextEventId++,
      runId: run.id,
      publishedBookmarkId: null,
      isPublished: true,
      createdAt: now,
    }));
    this.events.set(run.id, events);
    Object.assign(run, {
      status: "completed" as const,
      phase: "completed" as const,
      resultEventCount: events.length,
      resultBookmarkCount: events.length,
      isPublished: true,
      publishedAt: now,
      completedAt: now,
      updatedAt: now,
      errorCode: null,
      errorMessage: null,
    });
    return this.cloneRun(run);
  }

  async listEvents(runId: number): Promise<ContentAnalysisEvent[]> {
    return structuredClone(this.events.get(runId) ?? []);
  }

  private async hasActiveLease(lease: ContentAnalysisLease): Promise<boolean> {
    const durable = await this.durableJobs.get(lease.durableJobId);
    return Boolean(
      durable &&
      durable.status === "running" &&
      durable.leaseToken === lease.leaseToken &&
      durable.leaseExpiresAt &&
      durable.leaseExpiresAt > this.now()
    );
  }

  private cloneRun(run: ContentAnalysisRun): ContentAnalysisRun {
    return structuredClone(run);
  }
}
