/**
 * Face Recognition Service
 * Main service for face recognition, embedding management, and similarity matching
 */

import { db } from "@/config/drizzle";
import { eq, sql, and, desc, inArray } from "drizzle-orm";
import {
  creatorFaceEmbeddingsTable,
  videoFaceDetectionsTable,
  faceExtractionJobsTable,
  type NewCreatorFaceEmbedding,
  type CreatorFaceEmbedding,
  type VideoFaceDetection,
  videoCreatorsTable,
  creatorsTable,
} from "@/database/schema";
import { logger } from "@/utils/logger";
import { env } from "@/config/env";
import { NotFoundError } from "@/utils/errors";
import { getFaceRecognitionClient } from "./face-recognition.client";
import { getFrameExtractionService } from "@/modules/frame-extraction";
import { getFaceExtractionQueue } from "./face-extraction-queue.service";
import { thumbnailsService } from "@/modules/thumbnails/thumbnails.service";
import { storyboardsService } from "@/modules/storyboards/storyboards.service";
import { resizeAndSaveCreatorThumbnail } from "@/utils/image-processing";
import { recordPerfStage } from "@/utils/performance-profiler";
import { existsSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import type {
  SimilarityMatch,
  RawFaceDetection,
} from "./face-recognition.types";

export class FaceRecognitionService {
  private creatorFacesDir: string;

  constructor() {
    this.creatorFacesDir =
      env.CREATOR_FACE_THUMBNAILS_DIR || "./data/creator-face-thumbnails";

    if (!existsSync(this.creatorFacesDir)) {
      mkdirSync(this.creatorFacesDir, { recursive: true });
      logger.info(
        { creatorFacesDir: this.creatorFacesDir },
        "Created creator face thumbnails directory",
      );
    }
  }

  /**
   * Add a reference face embedding for a creator
   */
  async addCreatorEmbedding(params: {
    creatorId: number;
    imagePath: string;
    sourceType: string;
    sourceVideoId?: number;
    sourceTimestampSeconds?: number;
    isPrimary?: boolean;
  }): Promise<CreatorFaceEmbedding> {
    const {
      creatorId,
      imagePath,
      sourceType,
      sourceVideoId,
      sourceTimestampSeconds,
      isPrimary = false,
    } = params;

    // Detect face in image
    const faceClient = getFaceRecognitionClient();
    const result = await faceClient.detectFacesFromFile(imagePath);

    if (result.faces.length === 0) {
      throw new Error("No face detected in image");
    }

    if (result.faces.length > 1) {
      logger.warn(
        { count: result.faces.length },
        "Multiple faces detected, using first face",
      );
    }

    const face = result.faces[0];
    const embedding = JSON.stringify(face.embedding);

    let thumbnailPath: string | null = null;

    try {
      const filename = `creator_${creatorId}_embedding_${Date.now()}.webp`;
      const outputPath = join(this.creatorFacesDir, filename);

      await resizeAndSaveCreatorThumbnail({
        inputPath: imagePath,
        outputPath,
        faceBox: face.bbox,
        imageWidth: result.image_width,
        imageHeight: result.image_height,
        paddingScale: env.FACE_IMAGE_PADDING,
        size: 128,
        quality: 75,
      });

      thumbnailPath = outputPath;

      logger.debug(
        { creatorId, thumbnailPath },
        "Creator face thumbnail saved",
      );
    } catch (error) {
      logger.warn(
        { creatorId, error },
        "Failed to save creator face thumbnail (continuing without thumbnail)",
      );
    }

    // If setting as primary, unset other primary embeddings for this creator
    if (isPrimary) {
      await db
        .update(creatorFaceEmbeddingsTable)
        .set({ isPrimary: false })
        .where(eq(creatorFaceEmbeddingsTable.creatorId, creatorId));
    }

    // Insert embedding
    const newEmbedding: NewCreatorFaceEmbedding = {
      creatorId,
      embedding,
      sourceType,
      sourceVideoId,
      sourceTimestampSeconds,
      detScore: face.det_score,
      isPrimary,
      estimatedAge: face.age,
      estimatedGender: face.gender,
      thumbnailPath,
    };

    const inserted = await db
      .insert(creatorFaceEmbeddingsTable)
      .values(newEmbedding)
      .returning();

    logger.info(
      { creatorId, embeddingId: inserted[0].id },
      "Added creator face embedding",
    );

    return inserted[0];
  }

  /**
   * Get all face embeddings for a creator
   */
  async getCreatorEmbeddings(
    creatorId: number,
  ): Promise<CreatorFaceEmbedding[]> {
    return await db
      .select()
      .from(creatorFaceEmbeddingsTable)
      .where(eq(creatorFaceEmbeddingsTable.creatorId, creatorId))
      .orderBy(desc(creatorFaceEmbeddingsTable.isPrimary));
  }

  /**
   * Set a face embedding as primary for a creator
   */
  async setPrimaryEmbedding(
    creatorId: number,
    embeddingId: number,
  ): Promise<void> {
    // Unset other primary embeddings
    await db
      .update(creatorFaceEmbeddingsTable)
      .set({ isPrimary: false })
      .where(eq(creatorFaceEmbeddingsTable.creatorId, creatorId));

    // Set this one as primary
    await db
      .update(creatorFaceEmbeddingsTable)
      .set({ isPrimary: true })
      .where(eq(creatorFaceEmbeddingsTable.id, embeddingId));
  }

  /**
   * Delete a creator face embedding
   */
  async deleteCreatorEmbedding(embeddingId: number): Promise<void> {
    // Get the embedding first to delete the thumbnail file
    const embedding = await db
      .select({ thumbnailPath: creatorFaceEmbeddingsTable.thumbnailPath })
      .from(creatorFaceEmbeddingsTable)
      .where(eq(creatorFaceEmbeddingsTable.id, embeddingId))
      .limit(1)
      .then((rows) => rows[0]);

    // Delete thumbnail file if exists
    if (embedding?.thumbnailPath && existsSync(embedding.thumbnailPath)) {
      try {
        unlinkSync(embedding.thumbnailPath);
        logger.debug(
          { embeddingId, thumbnailPath: embedding.thumbnailPath },
          "Deleted creator face thumbnail",
        );
      } catch (error) {
        logger.warn(
          { embeddingId, error },
          "Failed to delete creator face thumbnail file",
        );
      }
    }

    await db
      .delete(creatorFaceEmbeddingsTable)
      .where(eq(creatorFaceEmbeddingsTable.id, embeddingId));
  }

  /**
   * Get face detections for a video
   */
  async getVideoFaceDetections(videoId: number): Promise<VideoFaceDetection[]> {
    return await db
      .select()
      .from(videoFaceDetectionsTable)
      .where(eq(videoFaceDetectionsTable.videoId, videoId))
      .orderBy(videoFaceDetectionsTable.timestampSeconds);
  }

  /**
   * Confirm a face match
   */
  async confirmFaceMatch(
    detectionId: number,
    creatorId: number,
  ): Promise<void> {
    // Get the videoId for this detection first
    const detection = await db
      .select({ videoId: videoFaceDetectionsTable.videoId })
      .from(videoFaceDetectionsTable)
      .where(eq(videoFaceDetectionsTable.id, detectionId))
      .limit(1)
      .then((rows) => rows[0]);

    if (!detection) {
      throw new NotFoundError(`Detection ${detectionId} not found`);
    }

    const { videoId } = detection;

    logger.info(
      { videoId, creatorId, detectionId },
      "Manually confirming face match - Auto-tagging and cleaning up",
    );

    // 1. Tag the creator on the video
    // Check if duplicate exists (since ON CONFLICT sometimes is tricky depending on constraints/DB state)
    const existing = await db
      .select()
      .from(videoCreatorsTable)
      .where(
        and(
          eq(videoCreatorsTable.videoId, videoId),
          eq(videoCreatorsTable.creatorId, creatorId),
        ),
      )
      .limit(1)
      .then((rows) => rows[0]);

    if (!existing) {
      await db
        .insert(videoCreatorsTable)
        .values({
          videoId,
          creatorId,
        })
        .onConflictDoNothing();
    }

    // 2. Delete ALL face detections for this creator on this video
    // (pending, confirmed, rejected - all of them)
    await db
      .delete(videoFaceDetectionsTable)
      .where(
        and(
          eq(videoFaceDetectionsTable.videoId, videoId),
          eq(videoFaceDetectionsTable.matchedCreatorId, creatorId),
        ),
      );

    // Also delete the specific detection ID if it wasn't caught by the above (e.g. if matchedCreatorId wasn't set yet)
    await db
      .delete(videoFaceDetectionsTable)
      .where(eq(videoFaceDetectionsTable.id, detectionId));
  }

  /**
   * Reject a face match
   */
  async rejectFaceMatch(detectionId: number): Promise<void> {
    await db
      .update(videoFaceDetectionsTable)
      .set({
        matchedCreatorId: null,
        matchConfidence: null,
        matchStatus: "rejected",
        updatedAt: new Date(),
      })
      .where(eq(videoFaceDetectionsTable.id, detectionId));
  }

  /**
   * Find similar creators for a face embedding using pgvector cosine similarity
   * This requires the pgvector extension and HNSW indexes to be set up
   */
  async findSimilarCreators(
    embedding: number[],
    limit: number = 10,
    threshold: number = env.FACE_SIMILARITY_THRESHOLD,
  ): Promise<SimilarityMatch[]> {
    // Convert embedding to vector format for pgvector
    const embeddingString = `[${embedding.join(",")}]`;

    // Using raw SQL for pgvector cosine similarity
    // The <=> operator computes cosine distance (1 - cosine_similarity)
    // We convert distance to similarity: similarity = 1 - distance
    const query = sql`
      SELECT
        cfe.id as reference_embedding_id,
        cfe.creator_id,
        c.name as creator_name,
        cfe.source_type as reference_source_type,
        1 - (cfe.embedding::vector <=> ${embeddingString}::vector) as similarity
      FROM ${creatorFaceEmbeddingsTable} cfe
      JOIN ${creatorsTable} c ON c.id = cfe.creator_id
      WHERE 1 - (cfe.embedding::vector <=> ${embeddingString}::vector) >= ${threshold}
      ORDER BY cfe.embedding::vector <=> ${embeddingString}::vector
      LIMIT ${limit}
    `;

    const result = await db.execute(query);

    return result.map((row: any) => ({
      creator_id: row.creator_id,
      creator_name: row.creator_name,
      similarity: row.similarity,
      reference_embedding_id: row.reference_embedding_id,
      reference_source_type: row.reference_source_type,
    }));
  }

  /**
   * Auto-match video face detections with creators
   * Only stores faces that match a creator - unidentified faces are discarded
   */
  async autoMatchVideoFaces(
    videoId: number,
    rawDetections: RawFaceDetection[],
    similarityThreshold: number = env.FACE_SIMILARITY_THRESHOLD,
    autoTagThreshold: number = env.FACE_AUTO_TAG_THRESHOLD,
  ): Promise<void> {
    logger.info(
      { videoId, count: rawDetections.length },
      "Auto-matching video faces",
    );

    if (rawDetections.length === 0) {
      return;
    }

    const creatorMatches = new Map<
      number,
      {
        creatorId: number;
        maxConfidence: number;
        detections: RawFaceDetection[];
      }
    >();

    for (const detection of rawDetections) {
      try {
        const matches = await this.findSimilarCreators(
          detection.embedding,
          1,
          similarityThreshold,
        );

        if (matches.length > 0) {
          const bestMatch = matches[0];
          const creatorId = bestMatch.creator_id;

          if (!creatorMatches.has(creatorId)) {
            creatorMatches.set(creatorId, {
              creatorId,
              maxConfidence: 0,
              detections: [],
            });
          }

          const group = creatorMatches.get(creatorId)!;
          group.detections.push(detection);
          if (bestMatch.similarity > group.maxConfidence) {
            group.maxConfidence = bestMatch.similarity;
          }

          (detection as any)._matchInfo = bestMatch;
        }
      } catch (error) {
        logger.error({ error }, "Failed to compute match");
      }
    }

    const detectionsToInsert: any[] = [];
    const videoCreatorsToInsert: any[] = [];
    const creatorsToCleanupDetections = new Set<number>();

    for (const group of creatorMatches.values()) {
      const { creatorId, maxConfidence, detections: groupDetections } = group;

      // Sort detections by match confidence (highest first)
      groupDetections.sort((a, b) => {
        const confA = (a as any)._matchInfo.similarity;
        const confB = (b as any)._matchInfo.similarity;
        return confB - confA;
      });

      if (maxConfidence >= autoTagThreshold) {
        logger.info(
          { videoId, creatorId, maxConfidence },
          "High confidence match found, auto-tagging creator",
        );

        videoCreatorsToInsert.push({ videoId, creatorId });
        creatorsToCleanupDetections.add(creatorId);

        const bestDetection = groupDetections[0];
        const matchInfo = (bestDetection as any)._matchInfo;

        detectionsToInsert.push({
          videoId,
          embedding: JSON.stringify(bestDetection.embedding),
          timestampSeconds: bestDetection.timestampSeconds,
          frameIndex: bestDetection.frameIndex,
          bboxX1: bestDetection.bbox[0],
          bboxY1: bestDetection.bbox[1],
          bboxX2: bestDetection.bbox[2],
          bboxY2: bestDetection.bbox[3],
          detScore: bestDetection.detScore,
          estimatedAge: bestDetection.estimatedAge,
          estimatedGender: bestDetection.estimatedGender,
          matchedCreatorId: matchInfo.creator_id,
          matchConfidence: matchInfo.similarity,
          matchStatus: "confirmed" as const,
        });
      } else {
        const limit = env.FACE_MAX_PENDING_PER_VIDEO;
        const detectionsToSave = groupDetections.slice(0, limit);

        for (const detection of detectionsToSave) {
          const matchInfo = (detection as any)._matchInfo;
          const matchStatus =
            matchInfo.similarity >= autoTagThreshold ? "confirmed" : "pending";

          detectionsToInsert.push({
            videoId,
            embedding: JSON.stringify(detection.embedding),
            timestampSeconds: detection.timestampSeconds,
            frameIndex: detection.frameIndex,
            bboxX1: detection.bbox[0],
            bboxY1: detection.bbox[1],
            bboxX2: detection.bbox[2],
            bboxY2: detection.bbox[3],
            detScore: detection.detScore,
            estimatedAge: detection.estimatedAge,
            estimatedGender: detection.estimatedGender,
            matchedCreatorId: matchInfo.creator_id,
            matchConfidence: matchInfo.similarity,
            matchStatus: matchStatus as any,
          });
        }
      }
    }

    if (videoCreatorsToInsert.length > 0 || creatorsToCleanupDetections.size > 0 || detectionsToInsert.length > 0) {
      await db.transaction(async (tx) => {
        // 1. Tag creators
        if (videoCreatorsToInsert.length > 0) {
          await tx
            .insert(videoCreatorsTable)
            .values(videoCreatorsToInsert)
            .onConflictDoNothing();
        }

        // 2. Clean up old detections for matched creators
        if (creatorsToCleanupDetections.size > 0) {
          const creatorIdsArray = Array.from(creatorsToCleanupDetections);
          await tx
            .delete(videoFaceDetectionsTable)
            .where(
              and(
                eq(videoFaceDetectionsTable.videoId, videoId),
                inArray(videoFaceDetectionsTable.matchedCreatorId, creatorIdsArray),
              ),
            );
        }

        // 3. Batch insert face detections
        if (detectionsToInsert.length > 0) {
          await tx.insert(videoFaceDetectionsTable).values(detectionsToInsert);
        }
      });
    }
  }

  /**
   * Unified workflow for initial library scan.
   * Keeps one extraction pass for thumbnail + storyboard + faces.
   */
  async processVideo(
    videoId: number,
    videoPath: string,
    videoDuration: number,
  ): Promise<void> {
    logger.info({ videoId }, "Starting unified video processing");

    const frameService = getFrameExtractionService();
    const result = await frameService.extractFrames({
      videoId,
      videoPath,
      videoDuration,
      intervalSeconds: env.STORYBOARD_INTERVAL_SECONDS,
    });

    logger.info(
      { videoId, framesExtracted: result.totalFrames },
      "Frames extracted",
    );

    try {
      const thumbnailPercent = env.THUMBNAIL_POSITION_PERCENT;
      const targetSeconds = videoDuration * (thumbnailPercent / 100);
      const closestFrame = frameService.findClosestFrame(
        result.frames,
        targetSeconds,
      );

      if (closestFrame) {
        await thumbnailsService.saveFromFrame(videoId, closestFrame);
        logger.info({ videoId }, "Thumbnail generated from extracted frame");
      }

      await storyboardsService.assembleFromFrames(
        videoId,
        result.frames,
        videoDuration,
      );
      logger.info({ videoId }, "Storyboard assembled from extracted frames");

      const faceQueue = getFaceExtractionQueue();
      await faceQueue.queueExtraction(videoId, result.frames);
      logger.info({ videoId }, "Face extraction queued");
    } catch (error) {
      await frameService.cleanupFrames(result.tempDirectory, {
        removeDirectory: true,
      });
      throw error;
    }
  }

  /**
   * Face-only workflow for on-demand endpoint.
   * Skips thumbnail/storyboard generation and uses face-optimized extraction settings.
   */
  async processFacesOnly(
    videoId: number,
    videoPath: string,
    videoDuration: number,
  ): Promise<void> {
    const totalStart = Date.now();
    logger.info({ videoId }, "Starting face-only processing");

    const frameService = getFrameExtractionService();
    const extractionStart = Date.now();
    const result = await frameService.extractFrames({
      videoId,
      videoPath,
      videoDuration,
      intervalSeconds: env.FACE_EXTRACTION_INTERVAL_SECONDS,
      keyframesOnly: true,
      targetWidth: env.FACE_EXTRACTION_MAX_WIDTH,
      outputFormat: env.FACE_EXTRACTION_FORMAT,
      quality: env.FACE_EXTRACTION_QUALITY,
      prefix: "face",
    });

    await recordPerfStage(
      { scenario: "face", videoId, mode: "process_faces_only" },
      "extract_frames",
      Date.now() - extractionStart,
      {
        frameCount: result.totalFrames,
        intervalSeconds: env.FACE_EXTRACTION_INTERVAL_SECONDS,
        targetWidth: env.FACE_EXTRACTION_MAX_WIDTH,
      },
    );

    logger.info(
      {
        videoId,
        framesExtracted: result.totalFrames,
        intervalSeconds: env.FACE_EXTRACTION_INTERVAL_SECONDS,
        targetWidth: env.FACE_EXTRACTION_MAX_WIDTH,
      },
      "Face-only frames extracted",
    );

    try {
      const faceQueue = getFaceExtractionQueue();
      const queueStart = Date.now();
      await faceQueue.queueExtraction(videoId, result.frames);
      await recordPerfStage(
        { scenario: "face", videoId, mode: "process_faces_only" },
        "queue_extraction",
        Date.now() - queueStart,
        { frameCount: result.totalFrames },
      );
      logger.info({ videoId }, "Face-only extraction queued");

      await recordPerfStage(
        { scenario: "face", videoId, mode: "process_faces_only" },
        "total",
        Date.now() - totalStart,
        { frameCount: result.totalFrames },
      );
    } catch (error) {
      await frameService.cleanupFrames(result.tempDirectory, {
        removeDirectory: true,
      });
      throw error;
    }
  }

  /**
   * Get face extraction job status
   */
  async getFaceExtractionJob(videoId: number) {
    const job = await db
      .select()
      .from(faceExtractionJobsTable)
      .where(eq(faceExtractionJobsTable.videoId, videoId))
      .limit(1)
      .then((rows) => rows[0] || null);

    if (!job) {
      throw new NotFoundError(
        `Face extraction job not found for video: ${videoId}`,
      );
    }

    return job;
  }

  /**
   * Clear the face extraction queue
   */
  async clearQueue(): Promise<void> {
    const queue = getFaceExtractionQueue();
    await queue.clearQueue();
  }

  /**
   * Find videos containing a specific creator (by face)
   */
  async findVideosWithCreator(
    creatorId: number,
    minConfidence: number = env.FACE_SIMILARITY_THRESHOLD,
  ): Promise<
    Array<{ videoId: number; detectionCount: number; avgConfidence: number }>
  > {
    const query = sql`
      SELECT
        video_id,
        COUNT(*) as detection_count,
        AVG(match_confidence) as avg_confidence
      FROM ${videoFaceDetectionsTable}
      WHERE matched_creator_id = ${creatorId}
        AND match_status IN ('confirmed', 'pending')
        AND match_confidence >= ${minConfidence}
      GROUP BY video_id
      ORDER BY detection_count DESC, avg_confidence DESC
    `;

    const result = await db.execute(query);

    return result.map((row: any) => ({
      videoId: row.video_id,
      detectionCount: row.detection_count,
      avgConfidence: row.avg_confidence,
    }));
  }
}

// Singleton instance
let serviceInstance: FaceRecognitionService | null = null;

export function getFaceRecognitionService(): FaceRecognitionService {
  if (!serviceInstance) {
    serviceInstance = new FaceRecognitionService();
  }
  return serviceInstance;
}

/**
 * For testing - reset singleton
 */
export function resetFaceRecognitionService(): void {
  serviceInstance = null;
}
