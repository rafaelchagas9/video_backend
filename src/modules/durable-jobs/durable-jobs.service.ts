import { randomUUID } from "crypto";
import type {
  CheckpointDurableJobInput,
  ClaimDurableJobInput,
  DurableJob,
  DurableJobsServiceDependencies,
  EnqueueDurableJobInput,
  FailDurableJobInput,
  HeartbeatDurableJobInput,
  LeaseMutationInput,
  RetryDurableJobInput,
} from "./durable-jobs.types";
import type { DurableJobStore } from "./durable-jobs.store";

export class DurableJobsService {
  private readonly now: () => Date;
  private readonly createLeaseToken: () => string;

  constructor(
    private readonly store: DurableJobStore,
    dependencies: DurableJobsServiceDependencies = {}
  ) {
    this.now = dependencies.now ?? (() => new Date());
    this.createLeaseToken = dependencies.createLeaseToken ?? randomUUID;
  }

  get(jobId: number): Promise<DurableJob | null> {
    return this.store.get(jobId);
  }

  enqueue(input: EnqueueDurableJobInput): Promise<DurableJob> {
    return this.store.enqueue(input, this.now());
  }

  claim(input: ClaimDurableJobInput): Promise<DurableJob | null> {
    if (!Number.isFinite(input.leaseDurationMs) || input.leaseDurationMs <= 0) {
      throw new RangeError(
        "leaseDurationMs must be finite and greater than zero"
      );
    }
    const now = this.now();
    return this.store.claim({
      ...input,
      leaseToken: this.createLeaseToken(),
      leaseExpiresAt: new Date(now.getTime() + input.leaseDurationMs),
      now,
    });
  }

  heartbeat(input: HeartbeatDurableJobInput): Promise<DurableJob | null> {
    if (!Number.isFinite(input.leaseDurationMs) || input.leaseDurationMs <= 0) {
      throw new RangeError(
        "leaseDurationMs must be finite and greater than zero"
      );
    }
    const now = this.now();
    return this.store.heartbeat({
      jobId: input.jobId,
      leaseToken: input.leaseToken,
      leaseExpiresAt: new Date(now.getTime() + input.leaseDurationMs),
      now,
    });
  }

  checkpoint(input: CheckpointDurableJobInput): Promise<DurableJob | null> {
    return this.store.checkpoint({ ...input, now: this.now() });
  }

  retry(input: RetryDurableJobInput): Promise<DurableJob | null> {
    return this.store.retry({ ...input, now: this.now() });
  }

  retryAfter(
    input: Omit<RetryDurableJobInput, "nextAttemptAt"> & { delayMs: number }
  ): Promise<DurableJob | null> {
    if (!Number.isFinite(input.delayMs) || input.delayMs < 0) {
      throw new RangeError("delayMs must be finite and non-negative");
    }
    const now = this.now();
    return this.store.retry({
      jobId: input.jobId,
      leaseToken: input.leaseToken,
      error: input.error,
      nextAttemptAt: new Date(now.getTime() + input.delayMs),
      now,
    });
  }

  requestCancellation(jobId: number): Promise<DurableJob | null> {
    return this.store.requestCancellation(jobId, this.now());
  }

  complete(input: LeaseMutationInput): Promise<DurableJob | null> {
    return this.store.complete({ ...input, now: this.now() });
  }

  fail(input: FailDurableJobInput): Promise<DurableJob | null> {
    return this.store.fail({ ...input, now: this.now() });
  }
}
