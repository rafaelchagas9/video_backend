import { logger } from "@/utils/logger";
import { DurableJobsService } from "./durable-jobs.service";
import type {
  DurableJob,
  DurableJobCheckpoint,
  DurableJobError,
} from "./durable-jobs.types";

export interface DurableJobHandlerContext {
  signal: AbortSignal;
  checkpoint(value: DurableJobCheckpoint): Promise<void>;
  heartbeat(): Promise<void>;
}

export type DurableJobHandler = (
  job: DurableJob,
  context: DurableJobHandlerContext
) => Promise<void>;

export interface DurableJobErrorClassification {
  retryable: boolean;
  error: DurableJobError;
}

export interface DurableJobWorkerOptions {
  workerId: string;
  leaseDurationMs: number;
  handlers: Record<string, DurableJobHandler>;
  kinds?: string[];
  heartbeatIntervalMs?: number;
  pollIntervalMs?: number;
  maxRetries?: number;
  retryDelayMs?: (job: DurableJob) => number;
  stopGracePeriodMs?: number;
  classifyError?: (
    error: unknown,
    job: DurableJob
  ) => DurableJobErrorClassification;
}

class LostLeaseError extends Error {
  constructor(jobId: number) {
    super(`Lease lost for durable job ${jobId}`);
    Object.setPrototypeOf(this, LostLeaseError.prototype);
  }
}

function defaultClassifyError(error: unknown): DurableJobErrorClassification {
  return {
    retryable: false,
    error: {
      code: "JOB_HANDLER_FAILED",
      message: error instanceof Error ? error.message : "Job handler failed",
    },
  };
}

/**
 * Claims and executes durable jobs without owning persistence or domain logic.
 * A handler can checkpoint work, but only the current lease may publish state.
 */
export class DurableJobWorker {
  private readonly heartbeatIntervalMs: number;
  private readonly pollIntervalMs: number;
  private readonly maxRetries: number;
  private readonly stopGracePeriodMs: number;
  private running = false;
  private runGeneration = 0;
  private loopPromise: Promise<void> | null = null;
  private activeController: AbortController | null = null;
  private pollController: AbortController | null = null;

  constructor(
    private readonly service: DurableJobsService,
    private readonly options: DurableJobWorkerOptions
  ) {
    if (options.leaseDurationMs <= 0) {
      throw new RangeError("leaseDurationMs must be greater than zero");
    }
    this.heartbeatIntervalMs =
      options.heartbeatIntervalMs ??
      Math.max(1, Math.floor(options.leaseDurationMs / 3));
    if (this.heartbeatIntervalMs >= options.leaseDurationMs) {
      throw new RangeError(
        "heartbeatIntervalMs must be shorter than leaseDurationMs"
      );
    }
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.stopGracePeriodMs = options.stopGracePeriodMs ?? 10_000;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const generation = ++this.runGeneration;
    this.loopPromise = this.runLoop(generation);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.pollController?.abort();
    this.activeController?.abort();
    const loopPromise = this.loopPromise;
    if (!loopPromise) return;

    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      loopPromise,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, this.stopGracePeriodMs);
        timeout.unref?.();
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    if (this.loopPromise === loopPromise) this.loopPromise = null;
  }

  async runOnce(): Promise<boolean> {
    const configuredKinds =
      this.options.kinds ?? Object.keys(this.options.handlers);
    if (configuredKinds.length === 0) return false;
    const job = await this.service.claim({
      workerId: this.options.workerId,
      leaseDurationMs: this.options.leaseDurationMs,
      ...(configuredKinds.length > 0 ? { kinds: configuredKinds } : {}),
    });
    if (!job || !job.leaseToken) return false;

    const leaseToken = job.leaseToken;
    if (job.retryCount > this.maxRetries) {
      const failed = await this.service.fail({
        jobId: job.id,
        leaseToken,
        error: {
          code: "JOB_RETRY_BUDGET_EXHAUSTED",
          message: "Durable job exceeded its retry and crash recovery budget",
        },
      });
      if (!failed) await this.logRejectedTerminalMutation(job.id, "fail");
      return true;
    }
    const handler = this.options.handlers[job.kind];
    if (!handler) {
      const failed = await this.service.fail({
        jobId: job.id,
        leaseToken,
        error: {
          code: "UNSUPPORTED_JOB_KIND",
          message: `No handler is registered for durable job kind ${job.kind}`,
        },
      });
      if (!failed) await this.logRejectedTerminalMutation(job.id, "fail");
      return true;
    }

    const controller = new AbortController();
    this.activeController = controller;
    let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
    let heartbeatInFlight: Promise<void> | null = null;
    let leaseLost = false;
    let executionFinished = false;

    const heartbeat = async (): Promise<void> => {
      const renewed = await this.service.heartbeat({
        jobId: job.id,
        leaseToken,
        leaseDurationMs: this.options.leaseDurationMs,
      });
      if (!renewed) {
        leaseLost = true;
        controller.abort(new LostLeaseError(job.id));
        throw new LostLeaseError(job.id);
      }
    };

    const scheduleHeartbeat = (): void => {
      heartbeatTimer = setTimeout(() => {
        heartbeatTimer = null;
        const task = heartbeat()
          .catch((error) => {
            logger.warn(
              { error, jobId: job.id },
              "Durable job heartbeat failed"
            );
          })
          .finally(() => {
            if (heartbeatInFlight === task) heartbeatInFlight = null;
            if (!executionFinished && !controller.signal.aborted) {
              scheduleHeartbeat();
            }
          });
        heartbeatInFlight = task;
      }, this.heartbeatIntervalMs);
    };

    const finishHeartbeats = async (): Promise<void> => {
      executionFinished = true;
      if (heartbeatTimer) {
        clearTimeout(heartbeatTimer);
        heartbeatTimer = null;
      }
      const activeHeartbeat = heartbeatInFlight;
      if (activeHeartbeat) await activeHeartbeat;
    };

    scheduleHeartbeat();
    try {
      await handler(job, {
        signal: controller.signal,
        heartbeat,
        checkpoint: async (checkpoint) => {
          const persisted = await this.service.checkpoint({
            jobId: job.id,
            leaseToken,
            checkpoint,
          });
          if (!persisted) {
            leaseLost = true;
            controller.abort(new LostLeaseError(job.id));
            throw new LostLeaseError(job.id);
          }
        },
      });

      await finishHeartbeats();
      if (!controller.signal.aborted) {
        const completed = await this.service.complete({
          jobId: job.id,
          leaseToken,
        });
        if (!completed) {
          const current = await this.service.get(job.id);
          if (!this.isSettledStatus(current?.status)) {
            logger.warn(
              { jobId: job.id, currentStatus: current?.status ?? "missing" },
              "Durable job completion rejected after ownership changed"
            );
            leaseLost = true;
            controller.abort(new LostLeaseError(job.id));
          }
        }
      }
    } catch (error) {
      await finishHeartbeats();
      if (leaseLost || controller.signal.aborted) {
        return true;
      }

      const classify = this.options.classifyError ?? defaultClassifyError;
      const classification = classify(error, job);
      if (classification.retryable && job.retryCount < this.maxRetries) {
        const delay = this.options.retryDelayMs?.(job) ?? 1_000;
        const retried = await this.service.retryAfter({
          jobId: job.id,
          leaseToken,
          error: classification.error,
          delayMs: Math.max(0, delay),
        });
        if (!retried) await this.logRejectedTerminalMutation(job.id, "retry");
      } else {
        const failed = await this.service.fail({
          jobId: job.id,
          leaseToken,
          error: classification.error,
        });
        if (!failed) await this.logRejectedTerminalMutation(job.id, "fail");
      }
    } finally {
      await finishHeartbeats();
      if (this.activeController === controller) this.activeController = null;
    }

    return true;
  }

  private async logRejectedTerminalMutation(
    jobId: number,
    operation: "retry" | "fail"
  ): Promise<void> {
    const current = await this.service.get(jobId);
    if (this.isSettledStatus(current?.status)) return;
    logger.warn(
      { jobId, operation, currentStatus: current?.status ?? "missing" },
      "Durable job terminal mutation rejected after ownership changed"
    );
  }

  private isSettledStatus(status: DurableJob["status"] | undefined): boolean {
    return (
      status === "completed" ||
      status === "retry_wait" ||
      status === "failed" ||
      status === "cancelled"
    );
  }

  private async runLoop(generation: number): Promise<void> {
    while (this.running && this.runGeneration === generation) {
      try {
        const processed = await this.runOnce();
        if (!processed) await this.waitForNextPoll();
      } catch (error) {
        logger.error({ error }, "Durable job worker iteration failed");
        await this.waitForNextPoll();
      }
    }
  }

  private async waitForNextPoll(): Promise<void> {
    if (!this.running) return;
    const controller = new AbortController();
    this.pollController = controller;
    try {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.pollIntervalMs);
        controller.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true }
        );
      });
    } finally {
      if (this.pollController === controller) this.pollController = null;
    }
  }
}
