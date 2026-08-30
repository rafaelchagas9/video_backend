import type { SystemBookmarkCategoryKey as NudityCategory } from "@/modules/bookmarks/bookmark-categories.constants";

export type ContentAnalysisProfile = "fast" | "balanced" | "thorough";
export type ContentAnalysisStatus =
  | "queued"
  | "running"
  | "retry_wait"
  | "completed"
  | "failed"
  | "cancelled";
export type ContentAnalysisPhase =
  | "queued"
  | "extracting"
  | "analyzing"
  | "refining"
  | "condensing"
  | "publishing"
  | "completed"
  | "failed"
  | "cancelled";

export interface ContentAnalysisVideoSource {
  id: number;
  sourceFingerprint: string;
  durationSeconds: number | null;
}

export interface ContentAnalysisRevisions {
  analyzerRevision: string;
  modelRevision: string;
  taxonomyRevision: string;
  configRevision: string;
}

export interface StartContentAnalysisInput {
  videoId: number;
  userId: number;
  profile?: ContentAnalysisProfile;
  categories?: NudityCategory[];
  force?: boolean;
  idempotencyKey?: string;
}

export interface StartContentAnalysisResult {
  run: ContentAnalysisRun;
  reused: boolean;
}

export interface ContentAnalysisRun extends ContentAnalysisRevisions {
  id: number;
  durableJobId: number;
  videoId: number;
  userId: number;
  kind: "nudity";
  profile: ContentAnalysisProfile;
  requestedCategories: NudityCategory[];
  status: ContentAnalysisStatus;
  phase: ContentAnalysisPhase;
  scannedSeconds: number;
  sourceDurationSeconds: number;
  sampledFrames: number;
  positiveFrames: number;
  sourceFingerprint: string;
  idempotencyKey: string | null;
  requestDigest: string;
  semanticGenerationKey: string;
  resultEventCount: number;
  resultBookmarkCount: number;
  errorCode: string | null;
  errorMessage: string | null;
  retryCount: number;
  isPublished: boolean;
  publishedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ContentAnalysisCategorySummary {
  category: NudityCategory;
  count: number;
  maxScore: number;
  meanScore: number;
  providerLabel?: string;
}

export interface ContentAnalysisEventDraft {
  generationKey: string;
  startSeconds: number;
  peakSeconds: number;
  endSeconds: number;
  categorySummary: ContentAnalysisCategorySummary[];
}

export interface ContentAnalysisEvent extends ContentAnalysisEventDraft {
  id: number;
  runId: number;
  publishedBookmarkId: number | null;
  isPublished: boolean;
  createdAt: Date;
}

export type ContentAnalysisObservationPhase = "coarse" | "refining";

export interface ContentAnalysisObservation {
  timestampSeconds: number;
  category: NudityCategory;
  score: number;
  providerLabel?: string;
}

export interface ContentAnalysisObservationChunk {
  phase: ContentAnalysisObservationPhase;
  chunkIndex: number;
  startSeconds: number;
  endSeconds: number;
  sampledFrames: number;
  positiveFrames: number;
  findings: ContentAnalysisObservation[];
}

export interface ContentAnalysisProgress {
  phase: Exclude<
    ContentAnalysisPhase,
    "queued" | "completed" | "failed" | "cancelled"
  >;
  scannedSeconds: number;
  sampledFrames: number;
  positiveFrames: number;
  cursor?: { chunkIndex: number; itemOffset?: number };
}

export interface ContentAnalysisResumeCheckpoint extends ContentAnalysisProgress {
  version: 1;
}

export interface ContentAnalysisProcessorContext {
  signal: AbortSignal;
  resumeCheckpoint: ContentAnalysisResumeCheckpoint | null;
  checkpoint(progress: ContentAnalysisProgress): Promise<void>;
  stageObservationChunk(chunk: ContentAnalysisObservationChunk): Promise<void>;
  loadObservationChunks(): Promise<ContentAnalysisObservationChunk[]>;
}

export interface ContentAnalysisProcessorResult {
  events: ContentAnalysisEventDraft[];
}

export type ContentAnalysisProcessor = (
  run: ContentAnalysisRun,
  context: ContentAnalysisProcessorContext
) => Promise<ContentAnalysisProcessorResult>;

export interface ContentAnalysisIntent extends ContentAnalysisRevisions {
  videoId: number;
  userId: number;
  kind: "nudity";
  profile: ContentAnalysisProfile;
  requestedCategories: NudityCategory[];
  sourceFingerprint: string;
  sourceDurationSeconds: number;
  idempotencyKey: string | null;
  requestDigest: string;
  semanticGenerationKey: string;
  force: boolean;
}

export interface ContentAnalysisLease {
  durableJobId: number;
  leaseToken: string;
}
