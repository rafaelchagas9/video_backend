import type { DurableJobStatus } from "@/modules/durable-jobs";
import type { CopyDetectionResults } from "@/modules/copy-detection/copy-detection.schemas";

export type LibrarySyncTask = "perceptual" | "faces" | "storyboards" | "previews" | "visual";
export type LibrarySyncTrigger = "manual" | "automatic";
export type LibrarySyncItemStatus = "completed" | "failed" | "skipped";
export type LibrarySyncPhase =
  "queued" | "scanning" | "executing" | "completed" | "failed" | "cancelled";

export interface LibrarySyncTaskProgress {
  total: number;
  processed: number;
  completed: number;
  failed: number;
  skipped: number;
  pending: number;
}

export interface LibrarySyncRecentItem {
  task: LibrarySyncTask;
  videoId: number;
  status: LibrarySyncItemStatus;
  result: Record<string, unknown> | null;
  error: { code: string; message: string } | null;
}

export interface LibrarySyncProgress {
  total: number;
  processed: number;
  completed: number;
  failed: number;
  skipped: number;
  pending: number;
  current: { task: LibrarySyncTask; videoId: number } | null;
  byTask: Record<LibrarySyncTask, LibrarySyncTaskProgress>;
}

/** Library-wide comparison that follows fingerprinting in a run with the perceptual task. */
export interface LibrarySyncMatching {
  stage: "prepare" | "join" | "verify" | "done";
  done: number;
  total: number;
  matches: number;
  rejected: number;
}

export interface LibrarySyncRun {
  id: number;
  /** Exact worker generation that owns this run's checkpoints and artifacts. */
  generation: string | null;
  tasks: LibrarySyncTask[];
  trigger: LibrarySyncTrigger;
  status: DurableJobStatus;
  phase: LibrarySyncPhase;
  progress: LibrarySyncProgress;
  recentItems: LibrarySyncRecentItem[];
  matching: LibrarySyncMatching | null;
  error: { code: string; message: string } | null;
  retryCount: number;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
}

export interface LibrarySyncCounts {
  totalVideos: number;
  tasks: Record<LibrarySyncTask, { pending: number; completed: number }>;
}

export interface LibrarySyncOverview {
  generation: string;
  capabilities: {
    perceptual: {
      enabled: boolean;
      code: "COPY_ENGINE_NOT_READY" | null;
      reason: string | null;
    };
  };
  settings: { autoPerceptual: boolean };
  counts: LibrarySyncCounts;
  activeRun: LibrarySyncRun | null;
  recentRuns: LibrarySyncRun[];
}

export interface LibrarySyncServiceContract {
  overview(): Promise<LibrarySyncOverview>;
  startRun(input: {
    tasks: LibrarySyncTask[];
    userId: number;
  }): Promise<{ run: LibrarySyncRun; reused: boolean }>;
  getRun(id: number): Promise<LibrarySyncRun>;
  cancelRun(id: number): Promise<LibrarySyncRun>;
  updateSettings(input: {
    autoPerceptual: boolean;
  }): Promise<{ autoPerceptual: boolean }>;
  perceptualResults(input: {
    view?: "copies" | "similarity";
    limit: number;
    offset: number;
  }): Promise<CopyDetectionResults>;
}
