/**
 * Conversion processor service
 * Handles the processing of conversion jobs from the queue
 */
import {
  existsSync,
  lstatSync,
  statSync,
  unlinkSync,
  type BigIntStats,
} from "fs";
import { link, mkdtemp, rm } from "fs/promises";
import { basename, dirname, join } from "path";
import { getPreset } from "@/config/presets";
import { metadataService } from "@/modules/videos/metadata.service";
import { videosService } from "@/modules/videos/videos.service";
import {
  ConversionCancelledError,
  ffmpegService,
} from "./conversion.ffmpeg.service";
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
import type {
  ConversionMediaMetadata,
  QueueJobPayload,
  ConversionEvent,
} from "./conversion.types";

export class ConversionProcessorService {
  /**
   * Process a conversion job (called by queue)
   */
  async processJob(
    payload: QueueJobPayload,
    signal: AbortSignal = new AbortController().signal
  ): Promise<void> {
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
    let progressUpdates = Promise.resolve();
    let tempDirectory: string | null = null;
    let completed = false;

    try {
      const startedAt = new Date();

      if (!(await conversionJobsService.claimForProcessing(jobId))) {
        logger.info(
          { jobId },
          "Skipping conversion job that is no longer pending"
        );
        return;
      }
      if (signal.aborted) throw new ConversionCancelledError();

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
      let originalIdentity: BigIntStats | null = null;

      try {
        originalIdentity = lstatSync(inputPath, { bigint: true });
        originalSizeBytes = statSync(inputPath).size;
      } catch (error) {
        logger.warn(
          { error, inputPath, jobId },
          "Failed to stat original file, using indexed size"
        );
      }

      // Probe the source before it is (possibly) replaced, so history keeps a
      // record of what was actually fed to the encoder.
      const sourceMetadata = this.withDerivedBitrate(
        await this.probeMedia(inputPath),
        originalSizeBytes
      );

      if (
        !sourceMetadata?.durationSeconds ||
        !Number.isFinite(sourceMetadata.durationSeconds) ||
        sourceMetadata.durationSeconds <= 0
      ) {
        throw new Error(
          "Source video metadata and duration could not be verified"
        );
      }

      if (existsSync(outputPath)) {
        throw new Error(
          "Conversion output already exists; refusing to overwrite it"
        );
      }
      tempDirectory = await mkdtemp(join(dirname(outputPath), ".conversion-"));
      const temporaryOutput = join(tempDirectory, "output.mkv");

      // Encode only into a directory owned by this attempt. Fallbacks and
      // cancellation must never truncate or remove a pre-existing media file.
      // Build and run FFmpeg command with progress callback
      const ffmpegResult = await ffmpegService.runConversion(
        jobId,
        video,
        inputPath,
        temporaryOutput,
        preset,
        job.target_resolution,
        (progress) => {
          progressUpdates = progressUpdates
            .then(async () => {
              const updated = await conversionJobsService.updateProgress(
                jobId,
                progress
              );
              if (!updated) return;

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
            })
            .catch((error) => {
              logger.warn(
                { error, jobId, progress },
                "Failed to persist conversion progress"
              );
            });
        },
        signal
      );
      await progressUpdates;
      if (signal.aborted) throw new ConversionCancelledError();

      const stats = statSync(temporaryOutput);
      const outputMetadata = this.withDerivedBitrate(
        await this.probeMedia(temporaryOutput),
        stats.size
      );
      this.validateOutput(sourceMetadata, outputMetadata, stats.size);
      if (signal.aborted) throw new ConversionCancelledError();

      // link is atomic, cannot overwrite an existing path, and uses the same
      // filesystem as the output. A collision preserves both files.
      await link(temporaryOutput, outputPath);
      const completedAt = new Date();
      completed = await conversionJobsService.markAsCompleted(
        jobId,
        stats.size
      );
      if (!completed) throw new ConversionCancelledError();

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
                job.target_resolution
              ),
          job.target_resolution
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
          "Failed to persist conversion history entry"
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
        "Conversion completed"
      );

      // Handle Original File Replacement (in-place)
      if (deleteOriginal) {
        try {
          logger.info(
            { videoId, jobId },
            "Replacing original file in-place (preserving video record and relations)"
          );
          await videosService.replaceFile(videoId, outputPath);
          const currentIdentity = lstatSync(inputPath, { bigint: true });
          if (
            originalIdentity?.isFile() &&
            currentIdentity.isFile() &&
            originalIdentity.dev === currentIdentity.dev &&
            originalIdentity.ino === currentIdentity.ino &&
            originalIdentity.size === currentIdentity.size &&
            originalIdentity.mtimeNs === currentIdentity.mtimeNs &&
            originalIdentity.ctimeNs === currentIdentity.ctimeNs
          ) {
            unlinkSync(inputPath);
          } else {
            logger.warn(
              { videoId, jobId },
              "Source changed during conversion; preserving the current file"
            );
          }
        } catch (error) {
          logger.error(
            { error, videoId },
            "Failed to replace original video after conversion"
          );
          // We don't fail job because conversion itself succeeded
        }
      }

      // Check for Batch Completion
      if (batchId) {
        await conversionBatchService.checkBatchCompletion(batchId);
      }
    } catch (error) {
      await progressUpdates;
      if (completed) {
        // Completion is committed. Batch/event enrichment failures cannot
        // retroactively cancel the job or remove its published media.
        logger.error(
          { error, jobId },
          "Conversion completed; follow-up work failed"
        );
        return;
      }
      if (signal.aborted || error instanceof ConversionCancelledError) {
        logger.info({ jobId }, "Conversion cancelled");
        if (batchId) {
          await conversionBatchService.checkBatchCompletion(batchId);
        }
        return;
      }

      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const ffmpegOutput =
        (error as Error & { stderrOutput?: string }).stderrOutput ?? undefined;

      // Update job as failed
      const failed = await conversionJobsService.markAsFailed(
        jobId,
        errorMessage,
        ffmpegOutput
      );
      if (!failed) {
        // A cancellation won the database race before the queue signal arrived.
        if (batchId) {
          await conversionBatchService.checkBatchCompletion(batchId);
        }
        return;
      }

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
    } finally {
      if (tempDirectory) {
        await rm(tempDirectory, { recursive: true, force: true }).catch(
          (error) => {
            logger.warn(
              { error, jobId },
              "Failed to remove conversion staging directory"
            );
          }
        );
      }
    }
  }

  private validateOutput(
    source: ConversionMediaMetadata | null,
    output: ConversionMediaMetadata | null,
    sizeBytes: number
  ): void {
    if (
      sizeBytes <= 0 ||
      !output ||
      !output.width ||
      !output.height ||
      !output.durationSeconds ||
      !Number.isFinite(output.durationSeconds) ||
      output.durationSeconds <= 0
    ) {
      throw new Error(
        "Converted video is empty or its metadata could not be validated"
      );
    }
    if (
      source?.durationSeconds &&
      Math.abs(output.durationSeconds - source.durationSeconds) > 1
    ) {
      throw new Error("Converted video duration does not match the source");
    }
    if (source?.audioCodec && !output.audioCodec) {
      throw new Error("Converted video is missing the source audio stream");
    }
  }

  /**
   * Probe media for conversion validation and history. The caller rejects
   * publication when required source or output metadata is unavailable.
   */
  private async probeMedia(
    filePath: string
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

  /**
   * ffprobe does not always report a container bitrate; derive it from
   * size/duration so bitrate comparisons stay usable across the whole history.
   */
  private withDerivedBitrate(
    metadata: ConversionMediaMetadata | null,
    sizeBytes: number
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
