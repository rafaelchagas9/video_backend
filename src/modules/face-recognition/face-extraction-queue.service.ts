/**
 * Face Extraction Queue Service
 * Background queue for processing video frames and extracting face embeddings
 */

import { db } from "@/config/drizzle";
import { eq } from "drizzle-orm";
import {
  faceExtractionJobsTable,
  videoFaceDetectionsTable,
} from "@/database/schema";
import { logger } from "@/utils/logger";
import { getFrameExtractionService } from "@/modules/frame-extraction";
import { env } from "@/config/env";
import { eventsService } from "@/modules/events/events.service";
import { createVideoEventContext } from "@/modules/events/events.types";
import { videosService } from "@/modules/videos/videos.service";
import { getFaceRecognitionClient } from "./face-recognition.client";
import { recordPerfStage } from "@/utils/performance-profiler";
import type {
  ExtractedFrame,
  FaceProcessingOptions,
  RawFaceDetection,
} from "./face-recognition.types";

export class FaceExtractionQueueService {
  private processingJobId: number | null = null;
  private pendingQueue: number[] = [];
  private pendingFrames: Map<number, ExtractedFrame[]> = new Map();
  private pendingTempDirs: Map<number, string> = new Map();
  private isProcessing = false;
  private options: Required<FaceProcessingOptions>;

  constructor(options: FaceProcessingOptions = {}) {
    this.options = {
      detectionThreshold: options.detectionThreshold ?? 0.5,
      similarityThreshold:
        options.similarityThreshold ?? env.FACE_SIMILARITY_THRESHOLD,
      autoTagThreshold: options.autoTagThreshold ?? env.FACE_AUTO_TAG_THRESHOLD,
      maxRetries: options.maxRetries ?? env.FACE_DETECTION_MAX_RETRIES,
      retryIntervalMs:
        options.retryIntervalMs ?? env.FACE_DETECTION_RETRY_INTERVAL_MS,
    };
  }

  /**
   * Queue a face extraction job for a video
   */
  async queueExtraction(
    videoId: number,
    frames: ExtractedFrame[],
  ): Promise<void> {
    // Check if job already exists
    const existingJob = await db
      .select()
      .from(faceExtractionJobsTable)
      .where(eq(faceExtractionJobsTable.videoId, videoId))
      .limit(1)
      .then((rows) => rows[0] || null);

    if (
      existingJob &&
      (existingJob.status === "processing" || existingJob.status === "pending")
    ) {
      logger.debug(
        { videoId },
        "Face extraction already queued or processing, skipping",
      );
      return;
    }

    // Clear previous detections before re-running
    if (existingJob) {
      await db
        .delete(videoFaceDetectionsTable)
        .where(eq(videoFaceDetectionsTable.videoId, videoId));
    }

    // Create or reset job
    if (existingJob) {
      await db
        .update(faceExtractionJobsTable)
        .set({
          status: "pending",
          totalFrames: frames.length,
          processedFrames: 0,
          facesDetected: 0,
          errorMessage: null,
          startedAt: null,
          completedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(faceExtractionJobsTable.id, existingJob.id));
    } else {
      await db.insert(faceExtractionJobsTable).values({
        videoId,
        status: "pending",
        totalFrames: frames.length,
        processedFrames: 0,
        facesDetected: 0,
        retryCount: 0,
      });
    }

    // Add to queue if not already present
    if (!this.pendingQueue.includes(videoId)) {
      this.pendingQueue.push(videoId);
      this.pendingFrames.set(videoId, frames);
      // Extract temp directory from first frame path
      if (frames.length > 0) {
        const tempDir = frames[0].filePath.substring(
          0,
          frames[0].filePath.lastIndexOf("/"),
        );
        this.pendingTempDirs.set(videoId, tempDir);
      }

      if (!this.isProcessing) {
        this.processQueue();
      }

      logger.info(
        { videoId, queueLength: this.pendingQueue.length },
        "Face extraction queued",
      );
    }
  }

  /**
   * Process the extraction queue sequentially
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing) return;

    this.isProcessing = true;

    while (this.pendingQueue.length > 0) {
      const videoId = this.pendingQueue.shift()!;

      try {
        const job = await db
          .select()
          .from(faceExtractionJobsTable)
          .where(eq(faceExtractionJobsTable.videoId, videoId))
          .limit(1)
          .then((rows) => rows[0] || null);

        if (!job) {
          logger.warn({ videoId }, "Face extraction job not found");
          continue;
        }

        this.processingJobId = job.id;

        // Check if face service is available
        const faceClient = getFaceRecognitionClient();
        const isAvailable = await faceClient.isAvailable();

        if (!isAvailable) {
          logger.warn(
            { videoId, jobId: job.id },
            "Face service unavailable, will retry later",
          );

          // Update retry count and re-queue if under max retries
          const newRetryCount = job.retryCount + 1;
          if (newRetryCount <= this.options.maxRetries) {
            await db
              .update(faceExtractionJobsTable)
              .set({
                retryCount: newRetryCount,
                errorMessage: "Face service unavailable",
                updatedAt: new Date(),
              })
              .where(eq(faceExtractionJobsTable.id, job.id));

            // Re-queue after interval
            setTimeout(() => {
              this.pendingQueue.push(videoId);
              if (!this.isProcessing) {
                this.processQueue();
              }
            }, this.options.retryIntervalMs);
          } else {
            await db
              .update(faceExtractionJobsTable)
              .set({
                status: "failed",
                errorMessage: "Face service unavailable after max retries",
                completedAt: new Date(),
                updatedAt: new Date(),
              })
              .where(eq(faceExtractionJobsTable.id, job.id));
          }

          continue;
        }

        logger.info(
          { videoId, jobId: job.id, remaining: this.pendingQueue.length },
          "Processing face extraction",
        );

        // Retrieve stored frames and temp directory
        const frames = this.pendingFrames.get(videoId) || [];
        const tempDir = this.pendingTempDirs.get(videoId);
        this.pendingFrames.delete(videoId);
        this.pendingTempDirs.delete(videoId);

        await this.processJob(job.id, videoId, frames, tempDir);
      } catch (error) {
        logger.error({ videoId, error }, "Face extraction failed");
      } finally {
        this.processingJobId = null;
      }
    }

    this.isProcessing = false;
  }

  /**
   * Process a single face extraction job
   */
  private async processJob(
    jobId: number,
    videoId: number,
    frames: ExtractedFrame[],
    tempDir?: string,
  ): Promise<void> {
    const totalStart = Date.now();
    const video = await videosService.findById(videoId);
    const videoContext = createVideoEventContext(video);

    // Update job status to processing
    await db
      .update(faceExtractionJobsTable)
      .set({
        status: "processing",
        startedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(faceExtractionJobsTable.id, jobId));

    // Broadcast start event
    await this.broadcastEvent({
      type: "face:extraction_started",
      videoId,
      message: {
        ...videoContext,
        message: "Face extraction started",
      },
    });

    try {
      // Get job details
      const job = await db
        .select()
        .from(faceExtractionJobsTable)
        .where(eq(faceExtractionJobsTable.id, jobId))
        .limit(1)
        .then((rows) => rows[0]);

      if (!job) {
        throw new Error("Job not found");
      }

      const rawDetections: RawFaceDetection[] = [];
      if (frames.length > 0) {
        const detectStart = Date.now();
        const detected = await this.processFrames(jobId, frames);
        rawDetections.push(...detected);
        await recordPerfStage(
          { scenario: "face", videoId, jobId, mode: "queue_job" },
          "detect_faces",
          Date.now() - detectStart,
          { frameCount: frames.length, detections: rawDetections.length },
        );
      } else {
        logger.warn(
          { videoId, jobId },
          "No frames to process for face extraction",
        );
      }

      const { getFaceRecognitionService } =
        await import("./face-recognition.service");
      const faceRecognitionService = getFaceRecognitionService();
      const matchStart = Date.now();
      await faceRecognitionService.autoMatchVideoFaces(
        videoId,
        rawDetections,
        this.options.similarityThreshold,
        this.options.autoTagThreshold,
      );
      await recordPerfStage(
        { scenario: "face", videoId, jobId, mode: "queue_job" },
        "auto_match",
        Date.now() - matchStart,
        { detections: rawDetections.length },
      );

      // Mark as completed
      await db
        .update(faceExtractionJobsTable)
        .set({
          status: "completed",
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(faceExtractionJobsTable.id, jobId));

      // Broadcast completion
      await this.broadcastEvent({
        type: "face:extraction_complete",
        videoId,
      message: {
          ...videoContext,
          message: "Face extraction complete",
          facesDetected: rawDetections.length,
        },
      });

      logger.info(
        { videoId, jobId, facesDetected: job.facesDetected },
        "Face extraction completed",
      );

      await recordPerfStage(
        { scenario: "face", videoId, jobId, mode: "queue_job" },
        "total",
        Date.now() - totalStart,
        { frameCount: frames.length, detections: rawDetections.length },
      );

      // Cleanup temp directory
      if (tempDir) {
        try {
          const frameService = getFrameExtractionService();
          await frameService.cleanupFrames(tempDir);
          logger.debug(
            { videoId, tempDir },
            "Cleaned up temp frames directory",
          );
        } catch (cleanupError) {
          logger.warn(
            { videoId, tempDir, error: cleanupError },
            "Failed to cleanup temp frames directory",
          );
        }
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      await db
        .update(faceExtractionJobsTable)
        .set({
          status: "failed",
          errorMessage,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(faceExtractionJobsTable.id, jobId));

      // Broadcast failure
      await this.broadcastEvent({
        type: "face:extraction_error",
        videoId,
        message: {
          ...videoContext,
          message: errorMessage,
        },
      });

      throw error;
    }
  }

  /**
   * Process frames for a specific job (called by orchestrator)
   * Returns raw face detections - matching/insertion is handled by autoMatchVideoFaces
   */
  async processFrames(
    jobId: number,
    frames: ExtractedFrame[],
  ): Promise<RawFaceDetection[]> {
    const faceClient = getFaceRecognitionClient();
    const rawDetections: RawFaceDetection[] = [];

    const batchSize = Math.max(1, env.FACE_DETECTION_BATCH_SIZE);

    for (let start = 0; start < frames.length; start += batchSize) {
      const batch = frames.slice(start, start + batchSize);

      const batchResults = await Promise.all(
        batch.map(async (frame) => {
          try {
            const result = await faceClient.detectFacesFromFile(frame.filePath);
            return { frame, faces: result.faces };
          } catch (error) {
            logger.error(
              { frame: frame.filePath, error },
              "Failed to process frame",
            );
            return { frame, faces: [] };
          }
        }),
      );

      for (const item of batchResults) {
        for (const face of item.faces) {
          rawDetections.push({
            embedding: face.embedding,
            timestampSeconds: item.frame.timestampSeconds,
            frameIndex: item.frame.frameIndex,
            bbox: face.bbox,
            detScore: face.det_score,
            estimatedAge: face.age,
            estimatedGender: face.gender,
          });
        }
      }

      await db
        .update(faceExtractionJobsTable)
        .set({
          processedFrames: Math.min(start + batch.length, frames.length),
          facesDetected: rawDetections.length,
          updatedAt: new Date(),
        })
        .where(eq(faceExtractionJobsTable.id, jobId));
    }

    return rawDetections;
  }

  /**
   * Broadcast event via SSE
   */
  private async broadcastEvent(params: {
    type: string;
    videoId: number;
    message: Record<string, unknown>;
  }): Promise<void> {
    try {
      eventsService.broadcastToAuthenticated({
        type: params.type,
        message: params.message,
      });

      logger.debug(
        { type: params.type, videoId: params.videoId },
        "Broadcasted face extraction event",
      );
    } catch (error) {
      logger.warn({ error }, "Failed to broadcast face extraction event");
    }
  }

  /**
   * Get current queue status
   */
  getQueueStatus(): {
    isProcessing: boolean;
    currentJobId: number | null;
    pendingCount: number;
  } {
    return {
      isProcessing: this.isProcessing,
      currentJobId: this.processingJobId,
      pendingCount: this.pendingQueue.length,
    };
  }

  /**
   * Clear all pending jobs from the queue
   */
  async clearQueue(): Promise<void> {
    // Clear in-memory queue
    const clearedCount = this.pendingQueue.length;
    this.pendingQueue = [];

    // Cancel pending jobs in database
    await db
      .update(faceExtractionJobsTable)
      .set({
        status: "skipped", // Using 'skipped' as it's a valid status in schema
        errorMessage: "Queue cleared by user",
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(faceExtractionJobsTable.status, "pending"));

    logger.info({ clearedCount }, "Face extraction queue cleared");
  }
}

// Singleton instance
let queueInstance: FaceExtractionQueueService | null = null;

export function getFaceExtractionQueue(): FaceExtractionQueueService {
  if (!queueInstance) {
    queueInstance = new FaceExtractionQueueService();
  }
  return queueInstance;
}

/**
 * For testing - reset singleton
 */
export function resetFaceExtractionQueue(): void {
  queueInstance = null;
}
