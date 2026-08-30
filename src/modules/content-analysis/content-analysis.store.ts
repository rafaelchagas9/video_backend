import type {
  ContentAnalysisEvent,
  ContentAnalysisEventDraft,
  ContentAnalysisIntent,
  ContentAnalysisLease,
  ContentAnalysisObservationChunk,
  ContentAnalysisProgress,
  ContentAnalysisRun,
  ContentAnalysisVideoSource,
} from "./content-analysis.types";

export interface ContentAnalysisRunStore {
  enqueue(
    intent: ContentAnalysisIntent
  ): Promise<{ run: ContentAnalysisRun; reused: boolean }>;
  findById(runId: number): Promise<ContentAnalysisRun | null>;
  findByDurableJobId(durableJobId: number): Promise<ContentAnalysisRun | null>;
  stageObservationChunk(
    runId: number,
    lease: ContentAnalysisLease,
    chunk: ContentAnalysisObservationChunk
  ): Promise<boolean>;
  listObservationChunks(
    runId: number
  ): Promise<ContentAnalysisObservationChunk[]>;
  updateProgress(
    runId: number,
    lease: ContentAnalysisLease,
    progress: ContentAnalysisProgress
  ): Promise<ContentAnalysisRun | null>;
  recordError(
    runId: number,
    lease: ContentAnalysisLease,
    input: {
      status: "retry_wait" | "failed";
      code: string;
      message: string;
      retryCount: number;
      retryDelayMs: number;
    }
  ): Promise<ContentAnalysisRun | null>;
  cancel(runId: number, userId: number): Promise<ContentAnalysisRun | null>;
  publish(input: {
    runId: number;
    lease: ContentAnalysisLease;
    source: ContentAnalysisVideoSource;
    events: ContentAnalysisEventDraft[];
  }): Promise<ContentAnalysisRun | null>;
  listEvents(runId: number): Promise<ContentAnalysisEvent[]>;
}

export interface ContentAnalysisCancellation {
  cancelActive(durableJobId: number, reason?: unknown): void;
}

export class ContentAnalysisIdempotencyConflictError extends Error {
  constructor() {
    super("Idempotency key belongs to a different analysis request");
    Object.setPrototypeOf(
      this,
      ContentAnalysisIdempotencyConflictError.prototype
    );
  }
}

export class ContentAnalysisLeaseLostError extends Error {
  constructor() {
    super("Content analysis lease is no longer active");
    Object.setPrototypeOf(this, ContentAnalysisLeaseLostError.prototype);
  }
}

export class ContentAnalysisSourceChangedError extends Error {
  readonly code = "CONTENT_SOURCE_CHANGED";

  constructor() {
    super("Video source fingerprint or duration changed during analysis");
    Object.setPrototypeOf(this, ContentAnalysisSourceChangedError.prototype);
  }
}

export class ContentAnalysisAnalyzerChangedError extends Error {
  readonly code = "ANALYZER_CHANGED";

  constructor() {
    super("Content analyzer revisions changed after the run was queued");
    Object.setPrototypeOf(this, ContentAnalysisAnalyzerChangedError.prototype);
  }
}

export class RetryableContentAnalysisError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    Object.setPrototypeOf(this, RetryableContentAnalysisError.prototype);
  }
}
