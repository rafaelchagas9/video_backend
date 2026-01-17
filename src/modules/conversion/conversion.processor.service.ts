/**
 * Conversion processor service
 * Handles the processing of conversion jobs from the queue
 */
import { statSync } from "fs";
import { getPreset } from "@/config/presets";
import { videosService } from "@/modules/videos/videos.service";
import { ffmpegService } from "./conversion.ffmpeg.service";
import { conversionJobsService } from "./conversion.jobs.service";
import { conversionBatchService } from "./conversion.batch.service";
import { websocketService } from "@/modules/websocket/websocket";
import { logger } from "@/utils/logger";
import type { QueueJobPayload, ConversionEvent } from "./conversion.types";

export class ConversionProcessorService {
  /**
   * Process a conversion job (called by queue)
   */
  async processJob(payload: QueueJobPayload): Promise<void> {
    const {
      jobId,
      videoId,
      preset: presetId,
      inputPath,
      outputPath,
      deleteOriginal,
      batchId,
    } = payload;

    try {
      // Update job status to processing
      await conversionJobsService.markAsProcessing(jobId);

      // Notify via WebSocket
      this.emitEvent({
        type: "conversion:started",
        message: {
          jobId,
          videoId,
          preset: presetId,
        },
      });

      const preset = getPreset(presetId);
      if (!preset) {
        throw new Error(`Invalid preset: ${presetId}`);
      }

      const job = await conversionJobsService.findById(jobId);
      const video = await videosService.findById(videoId);

      // Build and run FFmpeg command with progress callback
      await ffmpegService.runConversion(
        jobId,
        video,
        inputPath,
        outputPath,
        preset,
        job.target_resolution,
        async (progress) => {
          // Update progress in database
          await conversionJobsService.updateProgress(jobId, progress);

          // Emit progress event via WebSocket
          this.emitEvent({
            type: "conversion:progress",
            message: {
              jobId,
              videoId,
              preset: presetId,
              progress,
            },
          });
        },
      );

      // Get output file size
      const stats = statSync(outputPath);

      // Update job as completed
      await conversionJobsService.markAsCompleted(jobId, stats.size);

      // Notify via WebSocket
      this.emitEvent({
        type: "conversion:completed",
        message: {
          jobId,
          videoId,
          preset: presetId,
          progress: 100,
          outputPath,
        },
      });

      logger.info(
        { jobId, outputPath, size: stats.size },
        "Conversion completed",
      );

      // Handle Original File Deletion
      if (deleteOriginal) {
        try {
          logger.info(
            { videoId, jobId },
            "Deleting original file as requested",
          );
          await videosService.delete(videoId);
        } catch (error) {
          logger.error(
            { error, videoId },
            "Failed to delete original video after conversion",
          );
          // We don't fail job because conversion itself succeeded
        }
      }

      // Check for Batch Completion
      if (batchId) {
        await conversionBatchService.checkBatchCompletion(batchId);
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      // Update job as failed
      await conversionJobsService.markAsFailed(jobId, errorMessage);

      // Notify via WebSocket
      this.emitEvent({
        type: "conversion:failed",
        message: {
          jobId,
          videoId,
          preset: presetId,
          error: errorMessage,
        },
      });

      logger.error({ jobId, error: errorMessage }, "Conversion failed");

      // Check batch completion even on failure
      if (batchId) {
        await conversionBatchService.checkBatchCompletion(batchId);
      }

      throw error;
    }
  }

  /**
   * Emit WebSocket event
   */
  private emitEvent(event: ConversionEvent): void {
    try {
      websocketService.broadcast(event);
    } catch (error) {
      logger.error({ error }, "Failed to emit WebSocket event");
    }
  }
}

export const conversionProcessorService = new ConversionProcessorService();
