import type {
  CheckpointDurableJobInput,
  DurableJob,
  EnqueueDurableJobInput,
  FailDurableJobInput,
  LeaseMutationInput,
  RetryDurableJobInput,
} from "./durable-jobs.types";

/**
 * Persistence port for durable job state transitions.
 *
 * Implementations must apply claims and lease-bound mutations atomically. A
 * PostgreSQL adapter can map successful mutations to UPDATE ... RETURNING and
 * return null when the status, token, or lease condition no longer matches.
 */
export interface DurableJobStore {
  get(jobId: number): Promise<DurableJob | null>;
  enqueue(input: EnqueueDurableJobInput, now: Date): Promise<DurableJob>;
  claim(input: {
    workerId: string;
    leaseToken: string;
    leaseExpiresAt: Date;
    now: Date;
    kinds?: string[];
  }): Promise<DurableJob | null>;
  heartbeat(
    input: LeaseMutationInput & {
      leaseExpiresAt: Date;
      now: Date;
    }
  ): Promise<DurableJob | null>;
  checkpoint(
    input: CheckpointDurableJobInput & { now: Date }
  ): Promise<DurableJob | null>;
  retry(
    input: RetryDurableJobInput & { now: Date }
  ): Promise<DurableJob | null>;
  requestCancellation(jobId: number, now: Date): Promise<DurableJob | null>;
  complete(
    input: LeaseMutationInput & { now: Date }
  ): Promise<DurableJob | null>;
  fail(input: FailDurableJobInput & { now: Date }): Promise<DurableJob | null>;
}
