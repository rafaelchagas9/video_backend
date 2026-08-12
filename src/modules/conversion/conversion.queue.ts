/**
 * Redis-backed job queue for video conversion using Bun's native Redis client
 */
import { redis } from "bun";
import { logger } from "@/utils/logger";
import { env } from "@/config/env";
import type { QueueJobPayload } from "./conversion.types";
import { captureTelemetryException } from "@/utils/telemetry";
import {
  classifyFfmpegFailure,
  FfmpegProcessError,
} from "./conversion.ffmpeg.service";

const QUEUE_KEY = "conversion:jobs";
const PROCESSING_KEY = "conversion:processing";

type RedisClient = Pick<typeof redis, "send" | "set" | "del">;

export class ConversionQueue {
  private isProcessing = false;
  private concurrency: number;
  private activeJobs = 0;
  private activeRuns = new Set<Promise<void>>();
  private processor: ((job: QueueJobPayload) => Promise<void>) | null = null;
  private readonly redisClient: RedisClient;

  constructor(redisClient: RedisClient = redis) {
    this.concurrency = Math.max(1, env.CONVERSION_MAX_CONCURRENT);
    this.redisClient = redisClient;
  }

  /**
   * Add a job to the queue
   */
  async enqueue(payload: QueueJobPayload): Promise<void> {
    const jobData = JSON.stringify(payload);
    await this.redisClient.send("LPUSH", [QUEUE_KEY, jobData]);
    logger.info(
      { jobId: payload.jobId, preset: payload.preset },
      "Job enqueued"
    );

    // Trigger processing if not already running
    this.processNext();
  }

  /**
   * Set the job processor function
   */
  setProcessor(processor: (job: QueueJobPayload) => Promise<void>): void {
    this.processor = processor;
  }

  /**
   * Start processing jobs from the queue
   */
  async start(): Promise<void> {
    if (this.isProcessing) {
      logger.warn("Queue is already processing");
      return;
    }

    this.isProcessing = true;
    logger.info({ concurrency: this.concurrency }, "Conversion queue started");

    // Process any existing jobs
    this.processNext();
  }

  /**
   * Stop processing new jobs (wait for current jobs to finish)
   */
  async stop(): Promise<void> {
    this.isProcessing = false;
    await Promise.allSettled([...this.activeRuns]);
    logger.info("Conversion queue stopped");
  }

  /**
   * Process next job if capacity allows
   */
  private async processNext(): Promise<void> {
    if (!this.isProcessing || !this.processor) return;
    if (this.activeJobs >= this.concurrency) return;

    try {
      // Get next job from queue (non-blocking)
      const jobData = (await this.redisClient.send("RPOP", [QUEUE_KEY])) as
        | string
        | null;

      if (!jobData) {
        return; // No jobs in queue
      }

      const payload = JSON.parse(jobData) as QueueJobPayload;
      this.activeJobs++;

      // Process job asynchronously
      const run = this.runJob(payload)
        .catch((error) => {
          const ffmpegProperties =
            error instanceof FfmpegProcessError
              ? (() => {
                  const failureKind = classifyFfmpegFailure(error.stderrOutput);
                  return {
                    ffmpegExitCode: error.exitCode,
                    ffmpegFailureKind: failureKind,
                    encodingMode: error.encodingMode,
                    $exception_fingerprint: `conversion_ffmpeg:${payload.preset}:${error.encodingMode}:${error.exitCode ?? "spawn"}:${failureKind}`,
                  };
                })()
              : {};
          captureTelemetryException(error, {
            source: "conversion_job",
            jobId: payload.jobId,
            videoId: payload.videoId,
            preset: payload.preset,
            ...ffmpegProperties,
          });
          logger.error({ error, jobId: payload.jobId }, "Job processing error");
        })
        .finally(() => {
          this.activeJobs--;
          // Try to process next job
          void this.processNext();
        });
      this.activeRuns.add(run);
      void run.then(() => this.activeRuns.delete(run));

      // If we have capacity, try to get more jobs
      if (this.activeJobs < this.concurrency) {
        void this.processNext();
      }
    } catch (error) {
      logger.error({ error }, "Failed to get next job from queue");
    }
  }

  /**
   * Run a single job
   */
  private async runJob(payload: QueueJobPayload): Promise<void> {
    logger.info({ jobId: payload.jobId }, "Processing job");

    // Mark as processing in Redis
    await this.redisClient.set(
      `${PROCESSING_KEY}:${payload.jobId}`,
      JSON.stringify(payload)
    );

    try {
      await this.processor!(payload);
    } finally {
      // Remove from processing set
      await this.redisClient.del(`${PROCESSING_KEY}:${payload.jobId}`);
    }
  }

  /**
   * Get queue status
   */
  async getStatus(): Promise<{
    queueLength: number;
    activeJobs: number;
    isProcessing: boolean;
  }> {
    const queueLength = (await this.redisClient.send("LLEN", [
      QUEUE_KEY,
    ])) as number;
    return {
      queueLength,
      activeJobs: this.activeJobs,
      isProcessing: this.isProcessing,
    };
  }

  /**
   * Clear all pending jobs
   */
  async clear(): Promise<number> {
    const count = (await this.redisClient.send("LLEN", [QUEUE_KEY])) as number;
    await this.redisClient.del(QUEUE_KEY);
    logger.info({ count }, "Queue cleared");
    return count;
  }
}

export const conversionQueue = new ConversionQueue();
