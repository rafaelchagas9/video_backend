import { redis } from "bun";
import { logger } from "@/utils/logger";
import { captureTelemetryException } from "@/utils/telemetry";
import type { EditQueuePayload } from "./edits.types";

const QUEUE_KEY = "edits:jobs";
const PROCESSING_KEY = "edits:processing";

type EditProcessor = (
  job: EditQueuePayload,
  signal: AbortSignal
) => Promise<void>;
type RecoveryProvider = () => Promise<EditQueuePayload[]>;

export interface EditQueueRedisClient {
  send(command: string, args: string[]): Promise<unknown>;
}

function parsePayload(value: string): EditQueuePayload | null {
  try {
    const payload = JSON.parse(value) as Partial<EditQueuePayload>;
    if (
      !Number.isInteger(payload.jobId) ||
      !Number.isInteger(payload.videoId) ||
      !payload.outputConfig ||
      !payload.timelineConfig
    ) {
      return null;
    }
    return payload as EditQueuePayload;
  } catch {
    return null;
  }
}

export class EditsQueue {
  private isProcessing = false;
  private readonly concurrency = 1;
  private activeJobs = 0;
  private processor: EditProcessor | null = null;
  private recoveryProvider: RecoveryProvider | null = null;
  private readonly activeControllers = new Map<number, AbortController>();
  private readonly activeRuns = new Set<Promise<void>>();

  constructor(private readonly redisClient: EditQueueRedisClient = redis) {}

  async enqueue(payload: EditQueuePayload): Promise<void> {
    await this.redisClient.send("LPUSH", [QUEUE_KEY, JSON.stringify(payload)]);
    logger.info(
      { jobId: payload.jobId, videoId: payload.videoId },
      "Edit job enqueued"
    );
    void this.processNext();
  }

  setProcessor(processor: EditProcessor): void {
    this.processor = processor;
  }

  setRecoveryProvider(provider: RecoveryProvider): void {
    this.recoveryProvider = provider;
  }

  async start(): Promise<void> {
    if (this.isProcessing) {
      logger.warn("Edits queue is already processing");
      return;
    }

    await this.recoverInterruptedJobs();
    this.isProcessing = true;
    logger.info({ concurrency: this.concurrency }, "Edits queue started");
    void this.processNext();
  }

  async stop(): Promise<void> {
    this.isProcessing = false;
    for (const controller of this.activeControllers.values()) {
      controller.abort();
    }
    await Promise.allSettled([...this.activeRuns]);
    logger.info("Edits queue stopped");
  }

  /**
   * Remove a queued payload and/or signal an active renderer. Database status is
   * authoritative, so a payload that races with this method is still skipped by
   * the processor's conditional claim.
   */
  async cancel(jobId: number): Promise<void> {
    const controller = this.activeControllers.get(jobId);
    controller?.abort();

    const queued = (await this.redisClient.send("LRANGE", [
      QUEUE_KEY,
      "0",
      "-1",
    ])) as string[] | null;
    for (const value of queued ?? []) {
      if (parsePayload(value)?.jobId === jobId) {
        await this.redisClient.send("LREM", [QUEUE_KEY, "0", value]);
      }
    }

    logger.info(
      { jobId, active: Boolean(controller) },
      "Edit job cancellation requested"
    );
  }

  private async recoverInterruptedJobs(): Promise<void> {
    let recoveredClaims = 0;
    while (true) {
      const value = (await this.redisClient.send("RPOPLPUSH", [
        PROCESSING_KEY,
        QUEUE_KEY,
      ])) as string | null;
      if (!value) break;
      recoveredClaims++;
    }

    const existingValues = (await this.redisClient.send("LRANGE", [
      QUEUE_KEY,
      "0",
      "-1",
    ])) as string[] | null;
    const existingJobIds = new Set<number>();

    // Keep one payload per job. Invalid/duplicate values cannot be acknowledged
    // meaningfully and would otherwise poison every restart.
    for (const value of existingValues ?? []) {
      const payload = parsePayload(value);
      if (!payload || existingJobIds.has(payload.jobId)) {
        await this.redisClient.send("LREM", [QUEUE_KEY, "1", value]);
        continue;
      }
      existingJobIds.add(payload.jobId);
    }

    let recoveredFromDatabase = 0;
    if (this.recoveryProvider) {
      const recoverable = await this.recoveryProvider();
      for (const payload of recoverable) {
        if (existingJobIds.has(payload.jobId)) continue;
        await this.redisClient.send("LPUSH", [
          QUEUE_KEY,
          JSON.stringify(payload),
        ]);
        existingJobIds.add(payload.jobId);
        recoveredFromDatabase++;
      }
    }

    if (recoveredClaims > 0 || recoveredFromDatabase > 0) {
      logger.warn(
        { recoveredClaims, recoveredFromDatabase },
        "Recovered interrupted edit jobs"
      );
    }
  }

  private async processNext(): Promise<void> {
    if (!this.isProcessing || !this.processor) return;
    if (this.activeJobs >= this.concurrency) return;

    try {
      // RPOPLPUSH is the acknowledgement boundary: a claimed payload remains in
      // the processing list until its processor settles, so a crash can replay it.
      const jobData = (await this.redisClient.send("RPOPLPUSH", [
        QUEUE_KEY,
        PROCESSING_KEY,
      ])) as string | null;
      if (!jobData) return;

      const payload = parsePayload(jobData);
      if (!payload) {
        logger.error("Discarding invalid edit queue payload");
        await this.redisClient.send("LREM", [PROCESSING_KEY, "1", jobData]);
        void this.processNext();
        return;
      }

      this.activeJobs++;
      const run = this.runJob(payload, jobData)
        .catch((error) => {
          captureTelemetryException(error, {
            source: "edit_queue_job",
            jobId: payload.jobId,
            videoId: payload.videoId,
          });
          logger.error(
            { error, jobId: payload.jobId },
            "Edit job processing error"
          );
        })
        .finally(() => {
          this.activeJobs--;
          void this.processNext();
        });
      this.activeRuns.add(run);
      void run.finally(() => this.activeRuns.delete(run));
    } catch (error) {
      logger.error({ error }, "Failed to get next edit job from queue");
    }
  }

  private async runJob(
    payload: EditQueuePayload,
    serializedPayload: string
  ): Promise<void> {
    const controller = new AbortController();
    this.activeControllers.set(payload.jobId, controller);
    logger.info({ jobId: payload.jobId }, "Processing edit job");

    try {
      await this.processor!(payload, controller.signal);
      await this.redisClient.send("LREM", [
        PROCESSING_KEY,
        "1",
        serializedPayload,
      ]);
    } catch (error) {
      // Expected render failures are handled by the processor and return
      // normally. Before retrying an unexpected infrastructure failure, reset
      // its durable DB claim. If that is impossible (for example DB outage),
      // retain the Redis processing claim and stop instead of losing/spinning it.
      try {
        if (!this.recoveryProvider) throw new Error("No recovery provider set");
        await this.recoveryProvider();
        await this.redisClient.send("RPOPLPUSH", [PROCESSING_KEY, QUEUE_KEY]);
      } catch (recoveryError) {
        this.isProcessing = false;
        logger.error(
          { recoveryError, jobId: payload.jobId },
          "Edit queue stopped with an unacknowledged job"
        );
      }
      throw error;
    } finally {
      this.activeControllers.delete(payload.jobId);
    }
  }

  async getStatus(): Promise<{
    queueLength: number;
    activeJobs: number;
    isProcessing: boolean;
  }> {
    const queueLength = Number(
      await this.redisClient.send("LLEN", [QUEUE_KEY])
    );
    return {
      queueLength,
      activeJobs: this.activeJobs,
      isProcessing: this.isProcessing,
    };
  }
}

export const editsQueue = new EditsQueue();
