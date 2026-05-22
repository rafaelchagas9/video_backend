/**
 * Conversion processor service
 * Handles the processing of conversion jobs from the queue
 */
import { statSync, unlinkSync } from "fs";
import { basename } from "path";
import { getPreset } from "@/config/presets";
import { videosService } from "@/modules/videos/videos.service";
import { ffmpegService } from "./conversion.ffmpeg.service";
import { conversionJobsService } from "./conversion.jobs.service";
import { conversionBatchService } from "./conversion.batch.service";
import { conversionHistoryService } from "./conversion.history.service";
import { eventsService } from "@/modules/events/events.service";
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
      const startedAt = new Date();

      // Update job status to processing
      await conversionJobsService.markAsProcessing(jobId);

      // Notify via SSE
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
      let originalSizeBytes = video.file_size_bytes;

      try {
        originalSizeBytes = statSync(inputPath).size;
      } catch (error) {
        logger.warn(
          { error, inputPath, jobId },
          "Failed to stat original file, using indexed size",
        );
      }

      // Build and run FFmpeg command with progress callback
      const ffmpegResult = await ffmpegService.runConversion(
        jobId,
        video,
        inputPath,
        outputPath,
        preset,
        job.target_resolution,
        async (progress) => {
          // Update progress in database
          await conversionJobsService.updateProgress(jobId, progress);

          // Emit progress event via SSE
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
      const completedAt = new Date();

      // Update job as completed
      await conversionJobsService.markAsCompleted(jobId, stats.size);

      try {
        await conversionHistoryService.createCompletedEntry({
          conversionJobId: jobId,
          videoId,
          sourceFilePath: inputPath,
          sourceFileName: video.file_name || basename(inputPath),
          outputFilePath: outputPath,
          preset: presetId,
          codec: preset.codec,
          targetResolution: job.target_resolution,
          ffmpegCommand: ffmpegResult.command,
          originalSizeBytes,
          outputSizeBytes: stats.size,
          conversionDurationMs: ffmpegResult.durationMs,
          startedAt,
          completedAt,
        });
      } catch (error) {
        logger.error(
          { error, jobId, videoId },
          "Failed to persist conversion history entry",
        );
      }

      // Notify via SSE
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
        {
          jobId,
          outputPath,
          size: stats.size,
          originalSizeBytes,
          sizeDeltaBytes: stats.size - originalSizeBytes,
        },
        "Conversion completed",
      );

      // Handle Original File Replacement (in-place)
      if (deleteOriginal) {
        try {
          logger.info(
            { videoId, jobId },
            "Replacing original file in-place (preserving video record and relations)",
          );
          unlinkSync(inputPath);
          await videosService.replaceFile(videoId, outputPath);
        } catch (error) {
          logger.error(
            { error, videoId },
            "Failed to replace original video after conversion",
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
      const ffmpegOutput =
        (error as Error & { stderrOutput?: string }).stderrOutput ?? undefined;

      // Update job as failed
      await conversionJobsService.markAsFailed(
        jobId,
        errorMessage,
        ffmpegOutput,
      );

      // Notify via SSE
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
   * Emit SSE event
   */
  private emitEvent(event: ConversionEvent): void {
    try {
      eventsService.broadcast(event);
    } catch (error) {
      logger.error({ error }, "Failed to emit SSE event");
    }
  }
}

export const conversionProcessorService = new ConversionProcessorService();
