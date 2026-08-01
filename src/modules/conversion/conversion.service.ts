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
import { conversionHistoryService } from "./conversion.history.service";
import { conversionInsightsService } from "./conversion.insights.service";
import { conversionDemoService } from "./conversion.demo.service";
import { ffmpegService } from "./conversion.ffmpeg.service";
import { logger } from "@/utils/logger";
import { db } from "@/config/drizzle";
import { and, inArray, eq } from "drizzle-orm";
import { videosTable, conversionJobsTable } from "@/database/schema";
import type {
  ConversionHistoryFilters,
  ConversionHistoryListOptions,
  ConversionHistoryListResult,
  ConversionHistoryOverview,
  ConversionInsights,
  ConversionJob,
  CreateConversionJobInput,
  QueueJobPayload,
} from "./conversion.types";

export class ConversionService {
  constructor() {
    // Ensure converted videos directory exists
    if (!env.DEMO_MODE && !existsSync(env.CONVERTED_VIDEOS_DIR)) {
      mkdirSync(env.CONVERTED_VIDEOS_DIR, { recursive: true });
    }

    // Set up queue processor using the processor service
    if (!env.DEMO_MODE) {
      conversionQueue.setProcessor(
        conversionProcessorService.processJob.bind(conversionProcessorService),
      );
    }
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
   * Bulk create conversion jobs and add them to queue
   */
  async bulkCreateJobs(input: {
    videoIds: number[];
    preset: string;
    deleteOriginal?: boolean;
    batchId?: string;
  }): Promise<ConversionJob[]> {
    const { videoIds, preset: presetId, deleteOriginal, batchId } = input;
    if (videoIds.length === 0) return [];

    const preset = getPreset(presetId);
    if (!preset) {
      throw new BadRequestError(`Invalid preset: ${presetId}`);
    }

    // 1. Fetch all videos in a single query
    const videos = await db
      .select({
        id: videosTable.id,
        filePath: videosTable.filePath,
        fileName: videosTable.fileName,
        width: videosTable.width,
        height: videosTable.height,
      })
      .from(videosTable)
      .where(inArray(videosTable.id, videoIds));

    // 2. Fetch existing pending/processing jobs in a single query
    const existingJobs = await db
      .select({ videoId: conversionJobsTable.videoId })
      .from(conversionJobsTable)
      .where(
        and(
          inArray(conversionJobsTable.videoId, videoIds),
          eq(conversionJobsTable.preset, presetId),
          inArray(conversionJobsTable.status, ["pending", "processing"]),
        ),
      );

    const existingVideoIds = new Set(existingJobs.map((j) => j.videoId));
    const createdJobs: ConversionJob[] = [];

    // Filter out videos that already have a pending/processing job
    const videosToProcess = videos.filter((v) => !existingVideoIds.has(v.id));
    if (videosToProcess.length === 0) return [];

    // 3. Prepare bulk insert values
    const insertValues = videosToProcess.map((video) => {
      const targetResolution = ffmpegService.calculateTargetResolution(
        video.width,
        video.height,
        preset,
      );

      const outputFileName = this.generateOutputFileName(video.fileName, preset);
      let outputPath: string;

      if (deleteOriginal) {
        const originalDir = dirname(video.filePath);
        outputPath = join(originalDir, outputFileName);
      } else {
        outputPath = join(env.CONVERTED_VIDEOS_DIR, outputFileName);
      }

      return {
        videoId: video.id,
        status: "pending" as const,
        preset: presetId,
        targetResolution,
        codec: preset.codec,
        outputPath,
        deleteOriginal: deleteOriginal ?? false,
        batchId: batchId || null,
        progressPercent: 0,
      };
    });

    // 4. Perform bulk insert inside a transaction
    const results = await db.transaction(async (tx) => {
      return tx
        .insert(conversionJobsTable)
        .values(insertValues)
        .returning();
    });

    // 5. Enqueue each created job
    for (const row of results) {
      const video = videosToProcess.find((v) => v.id === row.videoId)!;
      const job: ConversionJob = {
        id: row.id,
        video_id: row.videoId,
        status: row.status as any,
        preset: row.preset,
        target_resolution: row.targetResolution,
        codec: row.codec,
        output_path: row.outputPath,
        output_size_bytes: row.outputSizeBytes,
        progress_percent: row.progressPercent ?? 0,
        error_message: row.errorMessage,
        ffmpeg_output: row.ffmpegOutput,
        delete_original: row.deleteOriginal,
        batch_id: row.batchId,
        started_at: row.startedAt?.toISOString() ?? null,
        completed_at: row.completedAt?.toISOString() ?? null,
        created_at: row.createdAt.toISOString(),
      };
      createdJobs.push(job);

      const queuePayload: QueueJobPayload = {
        jobId: job.id,
        videoId: job.video_id,
        preset: job.preset,
        inputPath: video.filePath,
        outputPath: job.output_path!,
        createdAt: new Date().toISOString(),
        deleteOriginal: job.delete_original,
        batchId: job.batch_id ?? undefined,
      };

      await conversionQueue.enqueue(queuePayload);
    }

    return createdJobs;
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
    if (env.DEMO_MODE) return [];
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
    if (env.DEMO_MODE) {
      return {
        queueLength: 0,
        activeJobs: 0,
        isProcessing: false,
      };
    }
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
    if (env.DEMO_MODE) return [];
    return conversionJobsService.getActiveConversions();
  }

  async getHistory(
    options?: ConversionHistoryListOptions,
  ): Promise<ConversionHistoryListResult> {
    if (env.DEMO_MODE) return conversionDemoService.list(options);
    return conversionHistoryService.list(options);
  }

  async getHistoryOverview(
    filters?: ConversionHistoryFilters,
  ): Promise<ConversionHistoryOverview> {
    if (env.DEMO_MODE) return conversionDemoService.overview(filters);
    return conversionHistoryService.getOverview(filters);
  }

  async getHistoryInsights(
    filters?: ConversionHistoryFilters,
  ): Promise<ConversionInsights> {
    if (env.DEMO_MODE) return conversionDemoService.insights(filters);
    return conversionInsightsService.getInsights(filters);
  }

  /** Distinct values available for the history filter controls. */
  async getHistoryFacets(): Promise<{
    presets: string[];
    source_codecs: string[];
  }> {
    if (env.DEMO_MODE) {
      return {
        presets: conversionDemoService.presets(),
        source_codecs: conversionDemoService.sourceCodecs(),
      };
    }

    const [presets, sourceCodecs] = await Promise.all([
      conversionHistoryService.listPresets(),
      conversionHistoryService.listSourceCodecs(),
    ]);

    return { presets, source_codecs: sourceCodecs };
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

    // Get job IDs for SSE notifications
    const pendingJobs =
      await conversionJobsService.getPendingJobsForNotification();
    const processingJobs =
      await conversionJobsService.getProcessingJobsForNotification();

    // Update pending jobs to cancelled
    const pendingCount = await conversionJobsService.clearPending();

    // Update processing jobs to failed (these are stuck)
    const processingCount = await conversionJobsService.clearProcessing();

    // Emit SSE events for cancelled jobs
    const { eventsService } = await import("@/modules/events/events.service");
    for (const job of pendingJobs) {
      try {
        eventsService.broadcast({
          type: "conversion:failed",
          message: {
            jobId: job.id,
            videoId: job.video_id,
            video_id: job.video_id,
            videoTitle: job.video_title,
            video_title: job.video_title,
            fileName: job.file_name ?? job.video_title,
            file_name: job.file_name ?? job.video_title,
            preset: job.preset,
            error: "Cancelled - queue cleared",
          },
        });
      } catch (error) {
        logger.error({ error }, "Failed to emit SSE event");
      }
    }

    // Emit SSE events for failed (stuck) jobs
    for (const job of processingJobs) {
      try {
        eventsService.broadcast({
          type: "conversion:failed",
          message: {
            jobId: job.id,
            videoId: job.video_id,
            video_id: job.video_id,
            videoTitle: job.video_title,
            video_title: job.video_title,
            fileName: job.file_name ?? job.video_title,
            file_name: job.file_name ?? job.video_title,
            preset: job.preset,
            error: "Manually cleared by user",
          },
        });
      } catch (error) {
        logger.error({ error }, "Failed to emit SSE event");
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
    if (env.DEMO_MODE) return [];

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
