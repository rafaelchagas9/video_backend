import { redis } from "bun";
import { logger } from "@/utils/logger";
import type { EditQueuePayload } from "./edits.types";

const QUEUE_KEY = "edits:jobs";
const PROCESSING_KEY = "edits:processing";

export class EditsQueue {
  private isProcessing = false;
  private concurrency: number;
  private activeJobs = 0;
  private processor: ((job: EditQueuePayload) => Promise<void>) | null = null;

  constructor() {
    // Default to 1 concurrent edit job as it is resource intensive (AV1 encoding)
    this.concurrency = 1;
  }

  /**
   * Add a job to the queue
   */
  async enqueue(payload: EditQueuePayload): Promise<void> {
    const jobData = JSON.stringify(payload);
    await redis.send("LPUSH", [QUEUE_KEY, jobData]);
    logger.info(
      { jobId: payload.jobId, videoId: payload.videoId },
      "Edit job enqueued",
    );

    // Trigger processing if not already running
    this.processNext();
  }

  /**
   * Set the job processor function
   */
  setProcessor(processor: (job: EditQueuePayload) => Promise<void>): void {
    this.processor = processor;
  }

  /**
   * Start processing jobs from the queue
   */
  async start(): Promise<void> {
    if (this.isProcessing) {
      logger.warn("Edits queue is already processing");
      return;
    }

    this.isProcessing = true;
    logger.info({ concurrency: this.concurrency }, "Edits queue started");

    // Process any existing jobs
    this.processNext();
  }

  /**
   * Stop processing new jobs
   */
  stop(): void {
    this.isProcessing = false;
    logger.info("Edits queue stopped");
  }

  /**
   * Process next job if capacity allows
   */
  private async processNext(): Promise<void> {
    if (!this.isProcessing || !this.processor) return;
    if (this.activeJobs >= this.concurrency) return;

    try {
      // Get next job from queue (non-blocking)
      const jobData = (await redis.send("RPOP", [QUEUE_KEY])) as string | null;

      if (!jobData) {
        return; // No jobs in queue
      }

      const payload = JSON.parse(jobData) as EditQueuePayload;
      this.activeJobs++;

      // Process job asynchronously
      this.runJob(payload)
        .catch((error) => {
          logger.error(
            { error, jobId: payload.jobId },
            "Edit job processing error",
          );
        })
        .finally(() => {
          this.activeJobs--;
          // Try to process next job
          this.processNext();
        });

      // If we have capacity, try to get more jobs
      if (this.activeJobs < this.concurrency) {
        this.processNext();
      }
    } catch (error) {
      logger.error({ error }, "Failed to get next edit job from queue");
    }
  }

  /**
   * Run a single job
   */
  private async runJob(payload: EditQueuePayload): Promise<void> {
    logger.info({ jobId: payload.jobId }, "Processing edit job");

    // Mark as processing in Redis
    await redis.set(
      `${PROCESSING_KEY}:${payload.jobId}`,
      JSON.stringify(payload),
    );

    try {
      await this.processor!(payload);
    } finally {
      // Remove from processing set
      await redis.del(`${PROCESSING_KEY}:${payload.jobId}`);
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
    const queueLength = (await redis.send("LLEN", [QUEUE_KEY])) as number;
    return {
      queueLength,
      activeJobs: this.activeJobs,
      isProcessing: this.isProcessing,
    };
  }
}

export const editsQueue = new EditsQueue();
