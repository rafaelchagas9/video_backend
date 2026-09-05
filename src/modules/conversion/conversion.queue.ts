/**
 * Redis-backed job queue for video conversion using Bun's native Redis client.
 * Claimed jobs remain in a processing list until they settle so a worker
 * restart can replay them safely.
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

type ConversionProcessor = (
  job: QueueJobPayload,
  signal: AbortSignal
) => Promise<void>;
type RecoveryProvider = () => Promise<QueueJobPayload[]>;

export interface ConversionQueueRedisClient {
  send(command: string, args: string[]): Promise<unknown>;
  del(key: string): Promise<number>;
}

function parsePayload(value: string): QueueJobPayload | null {
  try {
    const payload = JSON.parse(value) as Partial<QueueJobPayload>;
    if (
      !Number.isInteger(payload.jobId) ||
      !Number.isInteger(payload.videoId) ||
      typeof payload.preset !== "string" ||
      typeof payload.inputPath !== "string" ||
      typeof payload.outputPath !== "string" ||
      typeof payload.createdAt !== "string"
    ) {
      return null;
    }
    return payload as QueueJobPayload;
  } catch {
    return null;
  }
}

export class ConversionQueue {
  private isProcessing = false;
  private pendingClaim: Promise<void> | null = null;
  private refillRequested = false;
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private lifecycleVersion = 0;
  private readonly concurrency: number;
  private activeJobs = 0;
  private readonly activeRuns = new Set<Promise<void>>();
  private readonly activeControllers = new Map<number, AbortController>();
  private processor: ConversionProcessor | null = null;
  private recoveryProvider: RecoveryProvider | null = null;

  constructor(
    private readonly redisClient: ConversionQueueRedisClient = redis
  ) {
    this.concurrency = Math.max(1, env.CONVERSION_MAX_CONCURRENT);
  }

  async enqueue(payload: QueueJobPayload): Promise<void> {
    await this.redisClient.send("LPUSH", [QUEUE_KEY, JSON.stringify(payload)]);
    logger.info(
      { jobId: payload.jobId, preset: payload.preset },
      "Job enqueued"
    );
    void this.processNext();
  }

  setProcessor(processor: ConversionProcessor): void {
    this.processor = processor;
  }

  setRecoveryProvider(provider: RecoveryProvider): void {
    this.recoveryProvider = provider;
  }

  start(): Promise<void> {
    if (this.stopPromise) return this.stopPromise.then(() => this.start());
    if (this.startPromise) return this.startPromise;
    if (this.isProcessing) {
      logger.warn("Conversion queue is already processing");
      return Promise.resolve();
    }

    const version = this.lifecycleVersion;
    const start = this.recoverInterruptedJobs()
      .then(() => {
        if (version !== this.lifecycleVersion) return;
        this.isProcessing = true;
        logger.info(
          { concurrency: this.concurrency },
          "Conversion queue started"
        );
        this.processNext();
      })
      .finally(() => {
        this.startPromise = null;
      });
    this.startPromise = start;
    return start;
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.lifecycleVersion++;
    this.isProcessing = false;
    for (const controller of this.activeControllers.values()) {
      controller.abort();
    }
    const stop = (async () => {
      // Recovery and Redis claims may already be in flight. They must finish
      // without starting another renderer before shutdown can complete.
      if (this.startPromise) await Promise.allSettled([this.startPromise]);
      await this.pendingClaim;
      await Promise.allSettled([...this.activeRuns]);
      logger.info("Conversion queue stopped");
    })().finally(() => {
      this.stopPromise = null;
    });
    this.stopPromise = stop;
    return stop;
  }

  /**
   * Remove queued claims and signal a running encoder. The database transition
   * is performed first by ConversionService, so a racing payload is skipped by
   * the processor's conditional claim.
   */
  async cancel(jobId: number): Promise<void> {
    const controller = this.activeControllers.get(jobId);
    controller?.abort();

    await Promise.all([
      this.removeJobFromList(QUEUE_KEY, jobId),
      this.removeJobFromList(PROCESSING_KEY, jobId),
    ]);

    logger.info(
      { jobId, active: Boolean(controller) },
      "Conversion job cancellation requested"
    );
  }

  private async removeJobFromList(key: string, jobId: number): Promise<void> {
    const values = (await this.redisClient.send("LRANGE", [key, "0", "-1"])) as
      string[] | null;
    for (const value of values ?? []) {
      if (parsePayload(value)?.jobId === jobId) {
        await this.redisClient.send("LREM", [key, "0", value]);
      }
    }
  }

  private async recoverInterruptedJobs(): Promise<void> {
    const removedLegacyMarkers = await this.removeLegacyProcessingMarkers();
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
        // Remove markers written by queue versions that predate durable lists.
        await this.redisClient.del(`conversion:processing:${payload.jobId}`);
        if (existingJobIds.has(payload.jobId)) continue;
        await this.redisClient.send("LPUSH", [
          QUEUE_KEY,
          JSON.stringify(payload),
        ]);
        existingJobIds.add(payload.jobId);
        recoveredFromDatabase++;
      }
    }

    if (
      removedLegacyMarkers > 0 ||
      recoveredClaims > 0 ||
      recoveredFromDatabase > 0
    ) {
      logger.warn(
        { removedLegacyMarkers, recoveredClaims, recoveredFromDatabase },
        "Recovered interrupted conversion jobs"
      );
    }
  }

  private async removeLegacyProcessingMarkers(): Promise<number> {
    let cursor = "0";
    let removed = 0;

    do {
      const result = (await this.redisClient.send("SCAN", [
        cursor,
        "MATCH",
        "conversion:processing:*",
        "COUNT",
        "100",
      ])) as [string | number, string[]];
      cursor = String(result[0]);
      for (const key of result[1] ?? []) {
        removed += await this.redisClient.del(key);
      }
    } while (cursor !== "0");

    return removed;
  }

  private processNext(): void {
    if (!this.isProcessing || !this.processor) return;
    this.refillRequested = true;
    // Only one claim can cross Redis at a time. Its eventual renderer owns the
    // next free slot, even while the RPOPLPUSH response is pending.
    if (this.pendingClaim || this.activeJobs >= this.concurrency) return;
    this.refillRequested = false;
    const claim = this.claimNext().finally(() => {
      this.pendingClaim = null;
      if (this.refillRequested) this.processNext();
    });
    this.pendingClaim = claim;
  }

  private async claimNext(): Promise<void> {
    try {
      const jobData = (await this.redisClient.send("RPOPLPUSH", [
        QUEUE_KEY,
        PROCESSING_KEY,
      ])) as string | null;
      if (!jobData) return;
      if (!this.isProcessing) {
        // Return exactly this claim atomically, preserving both concurrent
        // cancellation and other running jobs' processing entries.
        await this.redisClient.send("EVAL", [
          "if redis.call('LREM', KEYS[1], 1, ARGV[1]) > 0 then return redis.call('RPUSH', KEYS[2], ARGV[1]) end return 0",
          "2",
          PROCESSING_KEY,
          QUEUE_KEY,
          jobData,
        ]);
        return;
      }

      const payload = parsePayload(jobData);
      if (!payload) {
        logger.error("Discarding invalid conversion queue payload");
        await this.redisClient.send("LREM", [PROCESSING_KEY, "1", jobData]);
        this.refillRequested = true;
        return;
      }

      this.activeJobs++;
      const run = this.runJob(payload, jobData)
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
          void this.processNext();
        });
      this.activeRuns.add(run);
      void run.finally(() => this.activeRuns.delete(run));
      this.refillRequested = true;
    } catch (error) {
      logger.error({ error }, "Failed to get next job from queue");
    }
  }

  private async runJob(
    payload: QueueJobPayload,
    serializedPayload: string
  ): Promise<void> {
    const controller = new AbortController();
    this.activeControllers.set(payload.jobId, controller);
    logger.info({ jobId: payload.jobId }, "Processing job");

    try {
      await this.processor!(payload, controller.signal);
    } finally {
      this.activeControllers.delete(payload.jobId);
      await this.redisClient.send("LREM", [
        PROCESSING_KEY,
        "1",
        serializedPayload,
      ]);
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

  async clear(): Promise<number> {
    const count = Number(await this.redisClient.send("LLEN", [QUEUE_KEY]));
    await this.redisClient.del(QUEUE_KEY);
    logger.info({ count }, "Queue cleared");
    return count;
  }
}

export const conversionQueue = new ConversionQueue();
