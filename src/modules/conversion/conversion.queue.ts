/**
 * Redis-backed job queue for video conversion using Bun's native Redis client
 */
import { redis } from 'bun';
import { logger } from '@/utils/logger';
import { env } from '@/config/env';
import type { QueueJobPayload } from './conversion.types';

const QUEUE_KEY = 'conversion:jobs';
const PROCESSING_KEY = 'conversion:processing';

export class ConversionQueue {
  private isProcessing = false;
  private concurrency: number;
  private activeJobs = 0;
  private processor: ((job: QueueJobPayload) => Promise<void>) | null = null;

  constructor() {
    this.concurrency = env.CONVERSION_MAX_CONCURRENT;
  }

  /**
   * Add a job to the queue
   */
  async enqueue(payload: QueueJobPayload): Promise<void> {
    const jobData = JSON.stringify(payload);
    await redis.send('LPUSH', [QUEUE_KEY, jobData]);
    logger.info({ jobId: payload.jobId, preset: payload.preset }, 'Job enqueued');
    
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
      logger.warn('Queue is already processing');
      return;
    }

    this.isProcessing = true;
    logger.info({ concurrency: this.concurrency }, 'Conversion queue started');
    
    // Process any existing jobs
    this.processNext();
  }

  /**
   * Stop processing new jobs (wait for current jobs to finish)
   */
  stop(): void {
    this.isProcessing = false;
    logger.info('Conversion queue stopped');
  }

  /**
   * Process next job if capacity allows
   */
  private async processNext(): Promise<void> {
    if (!this.isProcessing || !this.processor) return;
    if (this.activeJobs >= this.concurrency) return;

    try {
      // Get next job from queue (non-blocking)
      const jobData = await redis.send('RPOP', [QUEUE_KEY]) as string | null;
      
      if (!jobData) {
        return; // No jobs in queue
      }

      const payload = JSON.parse(jobData) as QueueJobPayload;
      this.activeJobs++;

      // Process job asynchronously
      this.runJob(payload)
        .catch((error) => {
          logger.error({ error, jobId: payload.jobId }, 'Job processing error');
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
      logger.error({ error }, 'Failed to get next job from queue');
    }
  }

  /**
   * Run a single job
   */
  private async runJob(payload: QueueJobPayload): Promise<void> {
    logger.info({ jobId: payload.jobId }, 'Processing job');

    // Mark as processing in Redis
    await redis.set(`${PROCESSING_KEY}:${payload.jobId}`, JSON.stringify(payload));

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
    const queueLength = await redis.send('LLEN', [QUEUE_KEY]) as number;
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
    const count = await redis.send('LLEN', [QUEUE_KEY]) as number;
    await redis.del(QUEUE_KEY);
    logger.info({ count }, 'Queue cleared');
    return count;
  }
}

export const conversionQueue = new ConversionQueue();
