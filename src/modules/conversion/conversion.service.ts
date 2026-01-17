/**
 * Video conversion service orchestrator
 * Coordinates conversion jobs using specialized services
 */
import { join, basename, extname, dirname } from "path";
import { existsSync, mkdirSync } from "fs";
import { env } from "@/config/env";
import { BadRequestError } from "@/utils/errors";
import { videosService } from "@/modules/videos/videos.service";
import { getPreset, listPresets } from "@/config/presets";
import { conversionQueue } from "./conversion.queue";
import { conversionProcessorService } from "./conversion.processor.service";
import { conversionJobsService } from "./conversion.jobs.service";
import { ffmpegService } from "./conversion.ffmpeg.service";
import { logger } from "@/utils/logger";
import type {
  ConversionJob,
  CreateConversionJobInput,
  QueueJobPayload,
} from "./conversion.types";

export class ConversionService {
  constructor() {
    // Ensure converted videos directory exists
    if (!existsSync(env.CONVERTED_VIDEOS_DIR)) {
      mkdirSync(env.CONVERTED_VIDEOS_DIR, { recursive: true });
    }

    // Set up queue processor using the processor service
    conversionQueue.setProcessor(
      conversionProcessorService.processJob.bind(conversionProcessorService),
    );
  }

  /**
   * Start conversion queue
   */
  async startQueue(): Promise<void> {
    await conversionQueue.start();
  }

  /**
   * Create a new conversion job and add to queue
   */
  async createJob(input: CreateConversionJobInput): Promise<ConversionJob> {
    const video = await videosService.findById(input.video_id);
    const preset = getPreset(input.preset);

    if (!preset) {
      throw new BadRequestError(`Invalid preset: ${input.preset}`);
    }

    // Determine target resolution based on video dimensions and preset
    const targetResolution = ffmpegService.calculateTargetResolution(
      video.width,
      video.height,
      preset,
    );

    // Generate output path
    const outputFileName = this.generateOutputFileName(video.file_name, preset);
    let outputPath: string;

    if (input.deleteOriginal) {
      // Use original directory
      const originalDir = dirname(video.file_path);
      outputPath = join(originalDir, outputFileName);
    } else {
      // Use default converted directory
      outputPath = join(env.CONVERTED_VIDEOS_DIR, outputFileName);
    }

    // Check if same job already exists and is pending/processing
    const existing = await conversionJobsService.findExisting(
      input.video_id,
      input.preset,
    );

    if (existing) {
      throw new BadRequestError(
        `Conversion job already ${existing.status} for this video with preset ${input.preset}`,
      );
    }

    // Create job record using jobs service
    const job = await conversionJobsService.create({
      videoId: input.video_id,
      preset: input.preset,
      targetResolution,
      codec: preset.codec,
      outputPath,
      deleteOriginal: input.deleteOriginal ?? false,
      batchId: input.batchId,
    });

    // Add to queue
    const queuePayload: QueueJobPayload = {
      jobId: job.id,
      videoId: input.video_id,
      preset: input.preset,
      inputPath: video.file_path,
      outputPath,
      createdAt: new Date().toISOString(),
      deleteOriginal: input.deleteOriginal,
      batchId: input.batchId,
    };

    await conversionQueue.enqueue(queuePayload);

    return job;
  }

  /**
   * Generate output filename
   */
  private generateOutputFileName(
    originalName: string,
    preset: { id: string },
  ): string {
    const baseName = basename(originalName, extname(originalName));
    const timestamp = Date.now();
    return `${baseName}_${preset.id}_${timestamp}.mkv`;
  }

  /**
   * Find job by ID
   */
  async findById(id: number): Promise<ConversionJob> {
    return conversionJobsService.findById(id);
  }

  /**
   * List jobs for a video
   */
  async listByVideoId(videoId: number): Promise<ConversionJob[]> {
    return conversionJobsService.listByVideoId(videoId);
  }

  /**
   * Cancel a pending job
   */
  async cancel(id: number): Promise<ConversionJob> {
    return conversionJobsService.cancel(id);
  }

  /**
   * Delete a job (only completed/failed/cancelled)
   */
  async delete(id: number): Promise<void> {
    const job = await conversionJobsService.findById(id);

    if (job.status === "pending" || job.status === "processing") {
      throw new BadRequestError(`Cannot delete job in ${job.status} status`);
    }

    // Delete output file if exists
    if (job.output_path && existsSync(job.output_path)) {
      try {
        const fs = await import("fs");
        fs.unlinkSync(job.output_path);
      } catch (error) {
        logger.warn(
          { error, path: job.output_path },
          "Failed to delete output file",
        );
      }
    }

    await conversionJobsService.delete(id);
  }

  /**
   * Get all available presets
   */
  getPresets() {
    return listPresets();
  }

  /**
   * Get queue status
   */
  async getQueueStatus() {
    return conversionQueue.getStatus();
  }

  /**
   * Get active conversions (pending and processing) with progress
   */
  async getActiveConversions(): Promise<
    {
      id: number;
      video_id: number;
      video_title: string;
      preset: string;
      status: "pending" | "processing";
      progress_percent: number;
      started_at: string | null;
      created_at: string;
    }[]
  > {
    return conversionJobsService.getActiveConversions();
  }

  /**
   * Clear all pending and processing jobs from the queue
   * - Clears Redis queue
   * - Sets pending jobs to 'cancelled'
   * - Sets processing jobs to 'failed' (stuck jobs)
   */
  async clearQueue(): Promise<{
    pendingCleared: number;
    processingReset: number;
  }> {
    // Clear Redis queue
    await conversionQueue.clear();

    // Get job IDs for WebSocket notifications
    const pendingJobs =
      await conversionJobsService.getPendingJobsForNotification();
    const processingJobs =
      await conversionJobsService.getProcessingJobsForNotification();

    // Update pending jobs to cancelled
    const pendingCount = await conversionJobsService.clearPending();

    // Update processing jobs to failed (these are stuck)
    const processingCount = await conversionJobsService.clearProcessing();

    // Emit WebSocket events for cancelled jobs
    const { websocketService } = await import("@/modules/websocket/websocket");
    for (const job of pendingJobs) {
      try {
        websocketService.broadcast({
          type: "conversion:failed",
          message: {
            jobId: job.id,
            videoId: job.video_id,
            preset: job.preset,
            error: "Cancelled - queue cleared",
          },
        });
      } catch (error) {
        logger.error({ error }, "Failed to emit WebSocket event");
      }
    }

    // Emit WebSocket events for failed (stuck) jobs
    for (const job of processingJobs) {
      try {
        websocketService.broadcast({
          type: "conversion:failed",
          message: {
            jobId: job.id,
            videoId: job.video_id,
            preset: job.preset,
            error: "Manually cleared by user",
          },
        });
      } catch (error) {
        logger.error({ error }, "Failed to emit WebSocket event");
      }
    }

    logger.info(
      {
        pendingCleared: pendingCount,
        processingReset: processingCount,
      },
      "Conversion queue cleared",
    );

    return {
      pendingCleared: pendingCount,
      processingReset: processingCount,
    };
  }

  /**
   * Get all videos currently in queue (pending or processing)
   * Returns list of jobs with video info
   */
  async getQueue(_userId: number) {
    // Get all pending/processing jobs with basic info
    const jobs = await conversionJobsService.findByVideoIds([]);

    if (jobs.length === 0) {
      return [];
    }

    // For now, return basic job info
    // TODO: Enhance this to fetch full video details if needed
    return jobs;
  }
}

export const conversionService = new ConversionService();
