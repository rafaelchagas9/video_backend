export type DurableJobStatus =
  | "queued"
  | "running"
  | "retry_wait"
  | "completed"
  | "failed"
  | "cancelled";

export interface DurableJob {
  id: number;
  kind: string;
  payload: Record<string, unknown>;
  status: DurableJobStatus;
  attempt: number;
  workerId: string | null;
  leaseToken: string | null;
  leaseExpiresAt: Date | null;
  checkpoint: DurableJobCheckpoint | null;
  retryCount: number;
  nextAttemptAt: Date | null;
  lastError: DurableJobError | null;
  startedAt: Date | null;
  heartbeatAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  cancelledAt: Date | null;
}

export interface DurableJobError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface DurableJobCheckpoint {
  stage: string;
  completedUnits: number;
  totalUnits?: number;
  data?: Record<string, unknown>;
}

export interface EnqueueDurableJobInput {
  kind: string;
  payload: Record<string, unknown>;
}

export interface ClaimDurableJobInput {
  workerId: string;
  leaseDurationMs: number;
  kinds?: string[];
}

export interface LeaseMutationInput {
  jobId: number;
  leaseToken: string;
}

export interface HeartbeatDurableJobInput extends LeaseMutationInput {
  leaseDurationMs: number;
}

export interface CheckpointDurableJobInput extends LeaseMutationInput {
  checkpoint: DurableJobCheckpoint;
}

export interface RetryDurableJobInput extends LeaseMutationInput {
  error: DurableJobError;
  nextAttemptAt: Date;
}

export interface FailDurableJobInput extends LeaseMutationInput {
  error: DurableJobError;
}

export interface DurableJobsServiceDependencies {
  now?: () => Date;
  createLeaseToken?: () => string;
}
