import type {
  CheckpointDurableJobInput,
  DurableJob,
  EnqueueDurableJobInput,
  FailDurableJobInput,
  LeaseMutationInput,
  RetryDurableJobInput,
} from "./durable-jobs.types";
import type { DurableJobStore } from "./durable-jobs.store";

function copyJob(job: DurableJob): DurableJob {
  return structuredClone(job);
}

export class InMemoryDurableJobStore implements DurableJobStore {
  private readonly jobs = new Map<number, DurableJob>();
  private nextId = 1;

  async get(jobId: number): Promise<DurableJob | null> {
    const job = this.jobs.get(jobId);
    return job ? copyJob(job) : null;
  }

  async enqueue(input: EnqueueDurableJobInput, now: Date): Promise<DurableJob> {
    const job: DurableJob = {
      id: this.nextId++,
      kind: input.kind,
      payload: structuredClone(input.payload),
      status: "queued",
      attempt: 0,
      workerId: null,
      leaseToken: null,
      leaseExpiresAt: null,
      checkpoint: null,
      retryCount: 0,
      nextAttemptAt: null,
      lastError: null,
      startedAt: null,
      heartbeatAt: null,
      createdAt: new Date(now),
      updatedAt: new Date(now),
      completedAt: null,
      cancelledAt: null,
    };
    this.jobs.set(job.id, job);
    return copyJob(job);
  }

  async heartbeat(
    input: LeaseMutationInput & { leaseExpiresAt: Date; now: Date }
  ): Promise<DurableJob | null> {
    const job = this.findClaimedJob(input, input.now);
    if (!job) return null;

    job.leaseExpiresAt = new Date(input.leaseExpiresAt);
    job.heartbeatAt = new Date(input.now);
    job.updatedAt = new Date(input.now);
    return copyJob(job);
  }

  async checkpoint(
    input: CheckpointDurableJobInput & { now: Date }
  ): Promise<DurableJob | null> {
    const job = this.findClaimedJob(input, input.now);
    if (!job) return null;

    job.checkpoint = structuredClone(input.checkpoint);
    job.updatedAt = new Date(input.now);
    return copyJob(job);
  }

  async claim(input: {
    workerId: string;
    leaseToken: string;
    leaseExpiresAt: Date;
    now: Date;
    kinds?: string[];
  }): Promise<DurableJob | null> {
    const job = [...this.jobs.values()]
      .sort((left, right) => left.id - right.id)
      .find((candidate) => {
        const kindMatches =
          !input.kinds || input.kinds.includes(candidate.kind);
        const isQueued = candidate.status === "queued";
        const retryIsDue =
          candidate.status === "retry_wait" &&
          candidate.nextAttemptAt !== null &&
          candidate.nextAttemptAt.getTime() <= input.now.getTime();
        const hasExpiredLease =
          candidate.status === "running" &&
          candidate.leaseExpiresAt !== null &&
          candidate.leaseExpiresAt.getTime() <= input.now.getTime();
        return kindMatches && (isQueued || retryIsDue || hasExpiredLease);
      });

    if (!job) return null;

    const reclaimedExpiredLease = job.status === "running";
    job.status = "running";
    job.attempt += 1;
    if (reclaimedExpiredLease) job.retryCount += 1;
    job.workerId = input.workerId;
    job.leaseToken = input.leaseToken;
    job.leaseExpiresAt = new Date(input.leaseExpiresAt);
    job.nextAttemptAt = null;
    job.startedAt ??= new Date(input.now);
    job.heartbeatAt = new Date(input.now);
    job.updatedAt = new Date(input.now);
    return copyJob(job);
  }

  async complete(
    input: LeaseMutationInput & { now: Date }
  ): Promise<DurableJob | null> {
    const job = this.findClaimedJob(input, input.now);
    if (!job) return null;

    job.status = "completed";
    job.workerId = null;
    job.leaseToken = null;
    job.leaseExpiresAt = null;
    job.completedAt = new Date(input.now);
    job.updatedAt = new Date(input.now);
    return copyJob(job);
  }

  async requestCancellation(
    jobId: number,
    now: Date
  ): Promise<DurableJob | null> {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    if (job.status === "cancelled") return copyJob(job);
    if (
      job.status !== "queued" &&
      job.status !== "running" &&
      job.status !== "retry_wait"
    ) {
      return null;
    }

    job.status = "cancelled";
    job.workerId = null;
    job.leaseToken = null;
    job.leaseExpiresAt = null;
    job.cancelledAt = new Date(now);
    job.completedAt = new Date(now);
    job.updatedAt = new Date(now);
    return copyJob(job);
  }

  async retry(
    input: RetryDurableJobInput & { now: Date }
  ): Promise<DurableJob | null> {
    const job = this.findClaimedJob(input, input.now);
    if (!job) return null;

    job.status = "retry_wait";
    job.retryCount += 1;
    job.nextAttemptAt = new Date(input.nextAttemptAt);
    job.lastError = structuredClone(input.error);
    job.workerId = null;
    job.leaseToken = null;
    job.leaseExpiresAt = null;
    job.updatedAt = new Date(input.now);
    return copyJob(job);
  }

  async fail(
    input: FailDurableJobInput & { now: Date }
  ): Promise<DurableJob | null> {
    const job = this.findClaimedJob(input, input.now);
    if (!job) return null;

    job.status = "failed";
    job.lastError = structuredClone(input.error);
    job.workerId = null;
    job.leaseToken = null;
    job.leaseExpiresAt = null;
    job.nextAttemptAt = null;
    job.completedAt = new Date(input.now);
    job.updatedAt = new Date(input.now);
    return copyJob(job);
  }

  private findClaimedJob(
    input: LeaseMutationInput,
    now: Date
  ): DurableJob | null {
    const job = this.jobs.get(input.jobId);
    if (
      !job ||
      job.status !== "running" ||
      job.leaseToken !== input.leaseToken ||
      job.leaseExpiresAt === null ||
      job.leaseExpiresAt.getTime() <= now.getTime()
    ) {
      return null;
    }
    return job;
  }
}
