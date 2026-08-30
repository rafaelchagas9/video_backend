import { db } from "@/config/drizzle";
import { env } from "@/config/env";
import { durableJobsTable, videosTable } from "@/database/schema";
import {
  DurableJobsService,
  DurableJobWorker,
  PostgresDurableJobStore,
  type DurableJob,
  type DurableJobErrorClassification,
  type DurableJobHandlerContext,
} from "@/modules/durable-jobs";
import {
  getFrameExtractionService,
  type FrameExtractionService,
} from "@/modules/frame-extraction";
import { logger } from "@/utils/logger";
import { and, eq, gt, sql, type SQL } from "drizzle-orm";
import { getFaceRecognitionClient } from "./face-recognition.client";
import { normalizeFaceBox } from "./face-recognition.coordinates";
import type {
  ExtractedFrame,
  FaceProcessingOptions,
  RawFaceDetection,
} from "./face-recognition.types";
import {
  PostgresFaceExtractionRunStore,
  type FaceExtractionConfig,
  type FaceExtractionRunStore,
} from "./face-extraction-run.store";

const FACE_JOB_KIND = "vision.face-extraction";

type VideoSource = {
  id: number;
  filePath: string;
  fileHash: string | null;
  fileSizeBytes: number;
  updatedAt: Date;
  durationSeconds: number | null;
};

type FaceClient = ReturnType<typeof getFaceRecognitionClient>;

export interface FacePublicationLease {
  durableJobId: number;
  leaseToken: string;
}

export interface FaceExtractionQueueDependencies {
  runStore: FaceExtractionRunStore;
  durableJobs: DurableJobsService;
  findVideo(
    videoId: number
  ): Promise<VideoSource | Record<string, unknown> | null>;
  frameService: Pick<FrameExtractionService, "extractFrames" | "cleanupFrames">;
  faceClient: Pick<FaceClient, "isAvailable" | "detectFacesFromFile">;
  publishDetections(
    videoId: number,
    detections: RawFaceDetection[],
    similarityThreshold: number,
    autoTagThreshold: number,
    publication: FacePublicationLease & { faceExtractionJobId: number }
  ): Promise<void>;
}

export class VisionServiceUnavailableError extends Error {
  constructor() {
    super("Vision service unavailable");
    Object.setPrototypeOf(this, VisionServiceUnavailableError.prototype);
  }
}

export async function isDurableFaceExtractionSchemaReady(): Promise<boolean> {
  try {
    await db.execute(sql`
      SELECT id, status, lease_token, lease_expires_at
      FROM ${durableJobsTable}
      LIMIT 0
    `);
    await db.execute(sql`
      SELECT durable_job_id, source_fingerprint, config, is_published
      FROM face_extraction_jobs
      LIMIT 0
    `);
    await db.execute(sql`
      SELECT face_extraction_job_id, is_published
      FROM video_face_detections
      LIMIT 0
    `);
    return true;
  } catch (error) {
    logger.warn(
      { error },
      "Durable face extraction is disabled until its schema migrations are applied"
    );
    return false;
  }
}

class DurableFaceLeaseLostError extends Error {
  constructor() {
    super("Durable face extraction lease is no longer active");
    Object.setPrototypeOf(this, DurableFaceLeaseLostError.prototype);
  }
}

function defaultConfig(options: FaceProcessingOptions): FaceExtractionConfig {
  return {
    detectionThreshold: options.detectionThreshold ?? 0.5,
    intervalSeconds: env.FACE_EXTRACTION_INTERVAL_SECONDS,
    keyframesOnly: true,
    targetWidth: env.FACE_EXTRACTION_MAX_WIDTH,
    outputFormat: env.FACE_EXTRACTION_FORMAT,
    quality: env.FACE_EXTRACTION_QUALITY,
    similarityThreshold:
      options.similarityThreshold ?? env.FACE_SIMILARITY_THRESHOLD,
    autoTagThreshold: options.autoTagThreshold ?? env.FACE_AUTO_TAG_THRESHOLD,
  };
}

function sourceFingerprint(
  video: VideoSource | Record<string, unknown>
): string {
  const source = video as Record<string, unknown>;
  const hash = source.fileHash ?? source.file_hash;
  if (typeof hash === "string" && hash.length > 0) return `xxh3-64:${hash}`;
  const size = source.fileSizeBytes ?? source.file_size_bytes;
  const updated = source.updatedAt ?? source.updated_at;
  const updatedValue =
    updated instanceof Date
      ? updated.toISOString()
      : String(updated ?? "unknown");
  return `metadata:${String(size ?? "unknown")}:${updatedValue}`;
}

function videoField<T>(
  video: VideoSource | Record<string, unknown>,
  camel: keyof VideoSource,
  snake: string
): T {
  const source = video as Record<string, unknown>;
  return (source[String(camel)] ?? source[snake]) as T;
}

function assertFaceConfig(value: unknown): FaceExtractionConfig {
  if (!value || typeof value !== "object") {
    throw new Error("Durable face extraction run has no configuration");
  }
  return value as FaceExtractionConfig;
}

function createDefaultDurableJobs(): DurableJobsService {
  return new DurableJobsService(
    new PostgresDurableJobStore({
      async execute<Row extends Record<string, unknown>>(query: SQL) {
        return Array.from(await db.execute<Row>(query)) as Row[];
      },
    })
  );
}

export class FaceExtractionQueueService {
  private readonly config: FaceExtractionConfig;
  private readonly dependencies: FaceExtractionQueueDependencies;
  private readonly worker: DurableJobWorker;

  constructor(
    options: FaceProcessingOptions = {},
    dependencies?: Partial<FaceExtractionQueueDependencies>
  ) {
    this.config = defaultConfig(options);
    const durableJobs = dependencies?.durableJobs ?? createDefaultDurableJobs();
    this.dependencies = {
      runStore: dependencies?.runStore ?? new PostgresFaceExtractionRunStore(),
      durableJobs,
      findVideo:
        dependencies?.findVideo ??
        (async (videoId) =>
          db
            .select()
            .from(videosTable)
            .where(eq(videosTable.id, videoId))
            .limit(1)
            .then((rows) => rows[0] ?? null)),
      frameService: dependencies?.frameService ?? getFrameExtractionService(),
      faceClient: dependencies?.faceClient ?? getFaceRecognitionClient(),
      publishDetections:
        dependencies?.publishDetections ??
        (async (
          videoId,
          detections,
          similarityThreshold,
          autoTagThreshold,
          publication
        ) => {
          const { getFaceRecognitionService } =
            await import("./face-recognition.service");
          await getFaceRecognitionService().autoMatchVideoFaces(
            videoId,
            detections,
            similarityThreshold,
            autoTagThreshold,
            {
              runId: publication.faceExtractionJobId,
              guard: async (tx) => {
                const activeLease = await tx
                  .select({ id: durableJobsTable.id })
                  .from(durableJobsTable)
                  .where(
                    and(
                      eq(durableJobsTable.id, publication.durableJobId),
                      eq(durableJobsTable.status, "running"),
                      eq(durableJobsTable.leaseToken, publication.leaseToken),
                      gt(durableJobsTable.leaseExpiresAt, new Date())
                    )
                  )
                  .for("update")
                  .limit(1);
                if (activeLease.length !== 1) {
                  throw new DurableFaceLeaseLostError();
                }
              },
            }
          );
        }),
    };
    this.worker = new DurableJobWorker(durableJobs, {
      workerId: `face-worker-${process.pid}`,
      leaseDurationMs: 60_000,
      stopGracePeriodMs: 10_000,
      maxRetries: options.maxRetries ?? env.FACE_DETECTION_MAX_RETRIES,
      retryDelayMs: () =>
        options.retryIntervalMs ?? env.FACE_DETECTION_RETRY_INTERVAL_MS,
      kinds: [FACE_JOB_KIND],
      handlers: {
        [FACE_JOB_KIND]: (job, context) => this.handleDurableJob(job, context),
      },
      classifyError: (error) => this.classifyError(error),
    });
  }

  start(): Promise<void> {
    return this.worker.start();
  }

  stop(): Promise<void> {
    return this.worker.stop();
  }

  async queueExtraction(videoId: number) {
    const video = await this.dependencies.findVideo(videoId);
    if (!video) throw new Error(`Video ${videoId} not found`);
    return this.dependencies.runStore.enqueue({
      videoId,
      sourceFingerprint: sourceFingerprint(video),
      config: this.config,
    });
  }

  async handleDurableJob(
    job: DurableJob,
    context: DurableJobHandlerContext
  ): Promise<void> {
    if (!job.leaseToken) {
      throw new Error(`Durable face job ${job.id} has no active lease token`);
    }
    const run = await this.dependencies.runStore.findByDurableJobId(job.id);
    if (!run || !run.durableJobId || !run.sourceFingerprint) {
      throw new Error(
        `Face extraction run not found for durable job ${job.id}`
      );
    }
    const config = assertFaceConfig(run.config);
    if (run.isPublished) {
      await this.dependencies.runStore.update(run.id, {
        status: "completed",
        completedAt: run.completedAt ?? new Date(),
      });
      return;
    }
    const video = await this.dependencies.findVideo(run.videoId);
    if (!video) throw new Error(`Video ${run.videoId} not found`);
    if (sourceFingerprint(video) !== run.sourceFingerprint) {
      throw new Error("Video source changed after face analysis was queued");
    }
    if (!(await this.dependencies.faceClient.isAvailable())) {
      throw new VisionServiceUnavailableError();
    }

    await this.dependencies.runStore.update(run.id, {
      status: "processing",
      startedAt: run.startedAt ?? new Date(),
      errorMessage: null,
    });

    let tempDirectory: string | null = null;
    try {
      const videoDuration = videoField<number>(
        video,
        "durationSeconds",
        "duration_seconds"
      );
      if (!Number.isFinite(videoDuration) || videoDuration <= 0) {
        throw new Error(`Video ${run.videoId} has no valid duration`);
      }
      const extracted = await this.dependencies.frameService.extractFrames({
        videoId: run.videoId,
        videoPath: videoField<string>(video, "filePath", "file_path"),
        videoDuration,
        intervalSeconds: config.intervalSeconds,
        keyframesOnly: config.keyframesOnly,
        targetWidth: config.targetWidth,
        outputFormat: config.outputFormat,
        quality: config.quality,
        prefix: "face",
      });
      tempDirectory = extracted.tempDirectory;
      await this.dependencies.runStore.update(run.id, {
        totalFrames: extracted.totalFrames,
      });

      const detections = await this.processFrames(
        run.id,
        extracted.frames,
        context,
        config.detectionThreshold
      );
      if (context.signal.aborted) throw new Error("Face extraction cancelled");
      await context.checkpoint({
        stage: "publishing",
        completedUnits: extracted.totalFrames,
        totalUnits: extracted.totalFrames,
      });
      const currentVideo = await this.dependencies.findVideo(run.videoId);
      if (
        !currentVideo ||
        sourceFingerprint(currentVideo) !== run.sourceFingerprint
      ) {
        throw new Error("Video source changed while face analysis was running");
      }
      await this.dependencies.publishDetections(
        run.videoId,
        detections,
        config.similarityThreshold,
        config.autoTagThreshold,
        {
          faceExtractionJobId: run.id,
          durableJobId: job.id,
          leaseToken: job.leaseToken,
        }
      );
      try {
        await this.dependencies.runStore.update(run.id, {
          status: "completed",
          facesDetected: detections.length,
          completedAt: new Date(),
        });
      } catch (projectionError) {
        logger.warn(
          { error: projectionError, videoId: run.videoId, runId: run.id },
          "Published face run but failed to update its status projection"
        );
      }
    } catch (error) {
      if (
        context.signal.aborted ||
        error instanceof DurableFaceLeaseLostError
      ) {
        throw error;
      }
      const classification = this.classifyError(error);
      await this.dependencies.runStore.update(run.id, {
        status: classification.retryable ? "pending" : "failed",
        errorMessage: classification.error.message,
        retryCount: job.retryCount + (classification.retryable ? 1 : 0),
        completedAt: classification.retryable ? null : new Date(),
      });
      throw error;
    } finally {
      if (tempDirectory) {
        try {
          await this.dependencies.frameService.cleanupFrames(tempDirectory, {
            removeDirectory: true,
          });
        } catch (cleanupError) {
          logger.warn(
            { error: cleanupError, videoId: run.videoId, runId: run.id },
            "Failed to clean durable face extraction frames"
          );
        }
      }
    }
  }

  async processFrames(
    runId: number,
    frames: ExtractedFrame[],
    context: DurableJobHandlerContext,
    detectionThreshold: number
  ): Promise<RawFaceDetection[]> {
    if (frames.length === 0) {
      throw new Error("No frames available for face inference");
    }
    const detections: RawFaceDetection[] = [];
    let successfulInferences = 0;
    const batchSize = Math.max(1, env.FACE_DETECTION_BATCH_SIZE);

    for (let start = 0; start < frames.length; start += batchSize) {
      if (context.signal.aborted) {
        throw context.signal.reason ?? new Error("Face extraction cancelled");
      }
      const batch = frames.slice(start, start + batchSize);
      const results = await Promise.all(
        batch.map(async (frame) => {
          try {
            const result =
              await this.dependencies.faceClient.detectFacesFromFile(
                frame.filePath,
                context.signal
              );
            return { frame, result };
          } catch (error) {
            if (context.signal.aborted) {
              throw context.signal.reason ?? error;
            }
            logger.warn(
              { error, runId },
              "Face inference failed for extracted frame"
            );
            return null;
          }
        })
      );
      if (context.signal.aborted) {
        throw context.signal.reason ?? new Error("Face extraction cancelled");
      }
      for (const item of results) {
        if (!item) continue;
        successfulInferences += 1;
        for (const face of item.result.faces) {
          if (face.det_score < detectionThreshold) continue;
          detections.push({
            embedding: face.embedding,
            timestampSeconds: item.frame.timestampSeconds,
            frameIndex: item.frame.frameIndex,
            bbox: normalizeFaceBox(
              face.bbox,
              item.result.image_width,
              item.result.image_height
            ),
            detScore: face.det_score,
          });
        }
      }
      const processedFrames = Math.min(start + batch.length, frames.length);
      await this.dependencies.runStore.update(runId, {
        processedFrames,
        facesDetected: detections.length,
      });
      await context.checkpoint({
        stage: "detecting",
        completedUnits: processedFrames,
        totalUnits: frames.length,
      });
    }
    if (frames.length > 0 && successfulInferences === 0) {
      throw new VisionServiceUnavailableError();
    }
    return detections;
  }

  classifyError(error: unknown): DurableJobErrorClassification {
    if (error instanceof VisionServiceUnavailableError) {
      return {
        retryable: true,
        error: {
          code: "VISION_SERVICE_UNAVAILABLE",
          message: error.message,
        },
      };
    }
    return {
      retryable: false,
      error: {
        code: "FACE_EXTRACTION_FAILED",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }

  async getLatestJob(videoId: number) {
    const run = await this.dependencies.runStore.latestByVideoId(videoId);
    if (!run?.durableJobId) return run;
    const durable = await this.dependencies.durableJobs.get(run.durableJobId);
    if (!durable) return run;
    const status =
      durable.status === "running"
        ? "processing"
        : durable.status === "completed"
          ? "completed"
          : durable.status === "failed"
            ? "failed"
            : durable.status === "cancelled"
              ? "skipped"
              : "pending";
    return { ...run, status, retryCount: durable.retryCount };
  }

  async clearQueue(): Promise<void> {
    const runs = await this.dependencies.runStore.listActive();
    await Promise.all(
      runs.map(async (run) => {
        if (run.durableJobId) {
          const cancelled =
            await this.dependencies.durableJobs.requestCancellation(
              run.durableJobId
            );
          if (cancelled?.status !== "cancelled") return;
        }
        await this.dependencies.runStore.update(run.id, {
          status: "skipped",
          completedAt: new Date(),
        });
      })
    );
  }
}

let singleton: FaceExtractionQueueService | null = null;

export function getDurableFaceExtractionQueue(): FaceExtractionQueueService {
  singleton ??= new FaceExtractionQueueService();
  return singleton;
}

export type { FaceExtractionRunStore } from "./face-extraction-run.store";
