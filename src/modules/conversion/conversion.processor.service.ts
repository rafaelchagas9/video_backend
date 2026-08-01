/**
 * Conversion processor service
 * Handles the processing of conversion jobs from the queue
 */
import { statSync, unlinkSync } from "fs";
import { basename } from "path";
import { getPreset } from "@/config/presets";
import { metadataService } from "@/modules/videos/metadata.service";
import { videosService } from "@/modules/videos/videos.service";
import { ffmpegService } from "./conversion.ffmpeg.service";
import { conversionJobsService } from "./conversion.jobs.service";
import { conversionBatchService } from "./conversion.batch.service";
import { conversionHistoryService } from "./conversion.history.service";
import {
  calculateEffectiveDimensions,
  formatEffectiveResolution,
} from "./conversion.planning";
import { eventsService } from "@/modules/events/events.service";
import { createVideoEventContext } from "@/modules/events/events.types";
import { logger } from "@/utils/logger";
import type { Video } from "@/modules/videos/videos.types";
import type {
  ConversionMediaMetadata,
  QueueJobPayload,
  ConversionEvent,
} from "./conversion.types";

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

    let videoContext: ReturnType<typeof createVideoEventContext> | null = null;

    try {
      const startedAt = new Date();

      // Update job status to processing
      await conversionJobsService.markAsProcessing(jobId);

      const preset = getPreset(presetId);
      if (!preset) {
        throw new Error(`Invalid preset: ${presetId}`);
      }

      const job = await conversionJobsService.findById(jobId);
      const video = await videosService.findById(videoId);
      const resolvedVideoContext = createVideoEventContext(video);
      videoContext = resolvedVideoContext;

      // Notify after resolving the video so clients receive a recognizable title.
      this.emitEvent({
        type: "conversion:started",
        message: {
          jobId,
          ...resolvedVideoContext,
          preset: presetId,
          ...(batchId ? { batchId } : {}),
        },
      });

      let originalSizeBytes = video.file_size_bytes;

      try {
        originalSizeBytes = statSync(inputPath).size;
      } catch (error) {
        logger.warn(
          { error, inputPath, jobId },
          "Failed to stat original file, using indexed size",
        );
      }

      // Probe the source before it is (possibly) replaced, so history keeps a
      // record of what was actually fed to the encoder.
      const sourceMetadata = this.withDerivedBitrate(
        (await this.probeMedia(inputPath)) ?? this.metadataFromVideo(video),
        originalSizeBytes,
      );

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
              ...resolvedVideoContext,
              preset: presetId,
              ...(batchId ? { batchId } : {}),
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

      const outputMetadata = this.withDerivedBitrate(
        await this.probeMedia(outputPath),
        stats.size,
      );

      try {
        const effectiveResolution = formatEffectiveResolution(
          outputMetadata?.width && outputMetadata.height
            ? {
                width: outputMetadata.width,
                height: outputMetadata.height,
              }
            : calculateEffectiveDimensions(
                sourceMetadata?.width ?? video.width,
                sourceMetadata?.height ?? video.height,
                job.target_resolution,
              ),
          job.target_resolution,
        );

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
          sourceMetadata,
          outputMetadata,
          profileVersion: ffmpegResult.profileVersion,
          plannedVideoBitrate: ffmpegResult.plannedVideoBitrate,
          plannedMaxBitrate: ffmpegResult.plannedMaxBitrate,
          plannedQp: ffmpegResult.plannedQp,
          effectiveResolution,
          encodingMode: ffmpegResult.encodingMode,
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
          ...resolvedVideoContext,
          preset: presetId,
          ...(batchId ? { batchId } : {}),
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
          ...(videoContext ?? {}),
          preset: presetId,
          ...(batchId ? { batchId } : {}),
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
   * Probe a file for technical metadata. Never throws: history is
   * supplementary and must not fail an otherwise successful conversion.
   */
  private async probeMedia(
    filePath: string,
  ): Promise<ConversionMediaMetadata | null> {
    try {
      const metadata = await metadataService.extractMetadata(filePath);

      return {
        width: metadata.width,
        height: metadata.height,
        fps: metadata.fps,
        codec: metadata.codec,
        audioCodec: metadata.audio_codec,
        bitrate: metadata.bitrate,
        durationSeconds: metadata.duration_seconds,
      };
    } catch (error) {
      logger.warn({ error, filePath }, "Failed to probe conversion metadata");
      return null;
    }
  }

  private metadataFromVideo(video: Video): ConversionMediaMetadata {
    return {
      width: video.width,
      height: video.height,
      fps: video.fps,
      codec: video.codec,
      audioCodec: video.audio_codec,
      bitrate: video.bitrate,
      durationSeconds: video.duration_seconds,
    };
  }

  /**
   * ffprobe does not always report a container bitrate; derive it from
   * size/duration so bitrate comparisons stay usable across the whole history.
   */
  private withDerivedBitrate(
    metadata: ConversionMediaMetadata | null,
    sizeBytes: number,
  ): ConversionMediaMetadata | null {
    if (!metadata || metadata.bitrate !== null) {
      return metadata;
    }

    const duration = metadata.durationSeconds;
    if (!duration || duration <= 0) {
      return metadata;
    }

    return {
      ...metadata,
      bitrate: Math.round((sizeBytes * 8) / duration),
    };
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
