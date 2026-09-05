/**
 * Face Recognition Service
 * Main service for face recognition, embedding management, and similarity matching
 */

import { db } from "@/config/drizzle";
import { eq, sql, and, desc } from "drizzle-orm";
import {
  creatorFaceEmbeddingsTable,
  videoFaceDetectionsTable,
  faceExtractionJobsTable,
  type NewCreatorFaceEmbedding,
  type NewVideoFaceDetection,
  videoCreatorsTable,
  creatorsTable,
} from "@/database/schema";
import { logger } from "@/utils/logger";
import { env } from "@/config/env";
import { NotFoundError } from "@/utils/errors";
import { getFaceRecognitionClient } from "./face-recognition.client";
import { getFrameExtractionService } from "@/modules/frame-extraction";
import { getDurableFaceExtractionQueue } from "./face-extraction-durable.service";
import { thumbnailsService } from "@/modules/thumbnails/thumbnails.service";
import { storyboardsService } from "@/modules/storyboards/storyboards.service";
import { resizeAndSaveCreatorThumbnail } from "@/utils/image-processing";
import { recordPerfStage } from "@/utils/performance-profiler";
import { existsSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import type {
  CreatorFaceEmbeddingRecord,
  SimilarityMatch,
  RawFaceDetection,
  VideoFaceDetectionRecord,
} from "./face-recognition.types";
import { faceRecognitionDemoService } from "./face-recognition.demo.service";
import {
  assertValidFaceEmbedding,
  FACE_EMBEDDING_DIMENSION,
} from "./face-recognition.embedding";

type FacePublicationTransaction = Parameters<
  Parameters<typeof db.transaction>[0]
>[0];

export interface FacePublicationContext {
  runId: number;
  guard: (tx: FacePublicationTransaction) => Promise<void>;
}

export class FaceRecognitionService {
  private creatorFacesDir: string;

  constructor() {
    this.creatorFacesDir =
      env.CREATOR_FACE_THUMBNAILS_DIR || "./data/creator-face-thumbnails";

    if (!env.DEMO_MODE && !existsSync(this.creatorFacesDir)) {
      mkdirSync(this.creatorFacesDir, { recursive: true });
      logger.info(
        { creatorFacesDir: this.creatorFacesDir },
        "Created creator face thumbnails directory"
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
  }): Promise<CreatorFaceEmbeddingRecord> {
    if (env.DEMO_MODE)
      return faceRecognitionDemoService.addCreatorEmbedding(params);
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
        "Multiple faces detected, using first face"
      );
    }

    const face = result.faces[0];
    assertValidFaceEmbedding(face.embedding, "Creator reference embedding");
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
        "Creator face thumbnail saved"
      );
    } catch (error) {
      logger.warn(
        { creatorId, error },
        "Failed to save creator face thumbnail (continuing without thumbnail)"
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
      thumbnailPath,
    };

    const inserted = await db
      .insert(creatorFaceEmbeddingsTable)
      .values(newEmbedding)
      .returning();

    logger.info(
      { creatorId, embeddingId: inserted[0].id },
      "Added creator face embedding"
    );

    return inserted[0];
  }

  /**
   * Get all face embeddings for a creator
   */
  async getCreatorEmbeddings(
    creatorId: number
  ): Promise<CreatorFaceEmbeddingRecord[]> {
    if (env.DEMO_MODE) {
      return faceRecognitionDemoService.getCreatorEmbeddings(creatorId);
    }

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
    embeddingId: number
  ): Promise<void> {
    if (env.DEMO_MODE)
      return faceRecognitionDemoService.setPrimaryEmbedding(
        creatorId,
        embeddingId
      );
    const target = await db
      .select({ id: creatorFaceEmbeddingsTable.id })
      .from(creatorFaceEmbeddingsTable)
      .where(
        and(
          eq(creatorFaceEmbeddingsTable.id, embeddingId),
          eq(creatorFaceEmbeddingsTable.creatorId, creatorId)
        )
      )
      .limit(1)
      .then((rows) => rows[0]);

    if (!target) {
      throw new NotFoundError(
        `Face embedding ${embeddingId} not found for creator ${creatorId}`
      );
    }

    await db.transaction(async (tx) => {
      await tx
        .update(creatorFaceEmbeddingsTable)
        .set({ isPrimary: false })
        .where(eq(creatorFaceEmbeddingsTable.creatorId, creatorId));

      await tx
        .update(creatorFaceEmbeddingsTable)
        .set({ isPrimary: true })
        .where(
          and(
            eq(creatorFaceEmbeddingsTable.id, embeddingId),
            eq(creatorFaceEmbeddingsTable.creatorId, creatorId)
          )
        );
    });
  }

  /**
   * Delete a creator face embedding
   */
  async deleteCreatorEmbedding(
    creatorId: number,
    embeddingId: number
  ): Promise<void> {
    if (env.DEMO_MODE)
      return faceRecognitionDemoService.deleteCreatorEmbedding(
        creatorId,
        embeddingId
      );
    // Get the embedding first to delete the thumbnail file
    const embedding = await db
      .select({ thumbnailPath: creatorFaceEmbeddingsTable.thumbnailPath })
      .from(creatorFaceEmbeddingsTable)
      .where(
        and(
          eq(creatorFaceEmbeddingsTable.id, embeddingId),
          eq(creatorFaceEmbeddingsTable.creatorId, creatorId)
        )
      )
      .limit(1)
      .then((rows) => rows[0]);

    if (!embedding) {
      throw new NotFoundError(
        `Face embedding ${embeddingId} not found for creator ${creatorId}`
      );
    }

    // Delete thumbnail file if exists
    if (embedding?.thumbnailPath && existsSync(embedding.thumbnailPath)) {
      try {
        unlinkSync(embedding.thumbnailPath);
        logger.debug(
          { embeddingId, thumbnailPath: embedding.thumbnailPath },
          "Deleted creator face thumbnail"
        );
      } catch (error) {
        logger.warn(
          { embeddingId, error },
          "Failed to delete creator face thumbnail file"
        );
      }
    }

    await db
      .delete(creatorFaceEmbeddingsTable)
      .where(
        and(
          eq(creatorFaceEmbeddingsTable.id, embeddingId),
          eq(creatorFaceEmbeddingsTable.creatorId, creatorId)
        )
      );
  }

  /**
   * Get face detections for a video
   */
  async getVideoFaceDetections(
    videoId: number
  ): Promise<VideoFaceDetectionRecord[]> {
    if (env.DEMO_MODE)
      return faceRecognitionDemoService.getVideoFaceDetections(videoId);
    return await db
      .select()
      .from(videoFaceDetectionsTable)
      .where(
        and(
          eq(videoFaceDetectionsTable.videoId, videoId),
          eq(videoFaceDetectionsTable.isPublished, true)
        )
      )
      .orderBy(videoFaceDetectionsTable.timestampSeconds);
  }

  /**
   * Confirm a face match
   */
  async confirmFaceMatch(
    videoId: number,
    detectionId: number,
    creatorId: number
  ): Promise<void> {
    if (env.DEMO_MODE)
      return faceRecognitionDemoService.confirmFaceMatch(
        videoId,
        detectionId,
        creatorId
      );
    // Resolve the detection only inside the video named by the route.
    const detection = await db
      .select({ videoId: videoFaceDetectionsTable.videoId })
      .from(videoFaceDetectionsTable)
      .where(
        and(
          eq(videoFaceDetectionsTable.id, detectionId),
          eq(videoFaceDetectionsTable.videoId, videoId),
          eq(videoFaceDetectionsTable.isPublished, true)
        )
      )
      .limit(1)
      .then((rows) => rows[0]);

    if (!detection) {
      throw new NotFoundError(`Detection ${detectionId} not found`);
    }

    logger.info(
      { videoId, creatorId, detectionId },
      "Manually confirming face match - Auto-tagging and cleaning up"
    );

    // 1. Tag the creator on the video
    // Check if duplicate exists (since ON CONFLICT sometimes is tricky depending on constraints/DB state)
    const existing = await db
      .select()
      .from(videoCreatorsTable)
      .where(
        and(
          eq(videoCreatorsTable.videoId, videoId),
          eq(videoCreatorsTable.creatorId, creatorId)
        )
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
          eq(videoFaceDetectionsTable.isPublished, true)
        )
      );

    // Also delete the specific detection ID if it wasn't caught by the above (e.g. if matchedCreatorId wasn't set yet)
    await db
      .delete(videoFaceDetectionsTable)
      .where(
        and(
          eq(videoFaceDetectionsTable.id, detectionId),
          eq(videoFaceDetectionsTable.videoId, videoId),
          eq(videoFaceDetectionsTable.isPublished, true)
        )
      );
  }

  /**
   * Reject a face match
   */
  async rejectFaceMatch(videoId: number, detectionId: number): Promise<void> {
    if (env.DEMO_MODE)
      return faceRecognitionDemoService.rejectFaceMatch(videoId, detectionId);
    const [updated] = await db
      .update(videoFaceDetectionsTable)
      .set({
        matchedCreatorId: null,
        matchConfidence: null,
        matchStatus: "rejected",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(videoFaceDetectionsTable.id, detectionId),
          eq(videoFaceDetectionsTable.videoId, videoId),
          eq(videoFaceDetectionsTable.isPublished, true)
        )
      )
      .returning({ id: videoFaceDetectionsTable.id });

    if (!updated) {
      throw new NotFoundError(
        `Detection ${detectionId} not found for video ${videoId}`
      );
    }
  }

  /**
   * Find similar creators for a face embedding using pgvector cosine similarity
   * This requires the pgvector extension and HNSW indexes to be set up
   */
  async findSimilarCreators(
    embedding: number[],
    limit: number = 10,
    threshold: number = env.FACE_SIMILARITY_THRESHOLD
  ): Promise<SimilarityMatch[]> {
    if (env.DEMO_MODE)
      return faceRecognitionDemoService.findSimilarCreators(
        embedding,
        limit,
        threshold
      );
    assertValidFaceEmbedding(embedding, "Similarity query embedding");

    // Convert embedding to vector format for pgvector
    const embeddingString = `[${embedding.join(",")}]`;

    // Using raw SQL for pgvector cosine similarity
    // The <=> operator computes cosine distance (1 - cosine_similarity)
    // We convert distance to similarity: similarity = 1 - distance
    const query = sql`
      WITH comparable_embeddings AS MATERIALIZED (
        SELECT
          cfe.id as reference_embedding_id,
          cfe.creator_id,
          c.name as creator_name,
          cfe.source_type as reference_source_type,
          CASE
            WHEN vector_dims(cfe.embedding::vector) = ${FACE_EMBEDDING_DIMENSION}
            THEN cfe.embedding::vector <=> ${embeddingString}::vector
            ELSE NULL
          END as distance
        FROM ${creatorFaceEmbeddingsTable} cfe
        JOIN ${creatorsTable} c ON c.id = cfe.creator_id
      )
      SELECT
        reference_embedding_id,
        creator_id,
        creator_name,
        reference_source_type,
        1 - distance as similarity
      FROM comparable_embeddings
      WHERE distance IS NOT NULL
        AND 1 - distance >= ${threshold}
      ORDER BY distance
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
    publicationContext?: FacePublicationContext
  ): Promise<void> {
    if (env.DEMO_MODE)
      return faceRecognitionDemoService.autoMatchVideoFaces(
        videoId,
        rawDetections,
        similarityThreshold
      );
    logger.info(
      { videoId, count: rawDetections.length },
      "Auto-matching video faces"
    );

    const creatorMatches = new Map<
      number,
      {
        creatorId: number;
        maxConfidence: number;
        detections: Array<{
          detection: RawFaceDetection;
          match: SimilarityMatch;
        }>;
      }
    >();

    for (const detection of rawDetections) {
      try {
        const matches = await this.findSimilarCreators(
          detection.embedding,
          1,
          similarityThreshold
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
          group.detections.push({ detection, match: bestMatch });
          if (bestMatch.similarity > group.maxConfidence) {
            group.maxConfidence = bestMatch.similarity;
          }
        }
      } catch (error) {
        logger.error({ error }, "Failed to compute match");
        throw error;
      }
    }

    const detectionsToInsert: NewVideoFaceDetection[] = [];
    const videoCreatorsToInsert: Array<{
      videoId: number;
      creatorId: number;
    }> = [];

    for (const group of creatorMatches.values()) {
      const { creatorId, maxConfidence, detections: groupDetections } = group;

      // Sort detections by match confidence (highest first)
      groupDetections.sort((a, b) => {
        return b.match.similarity - a.match.similarity;
      });

      if (maxConfidence >= autoTagThreshold) {
        logger.info(
          { videoId, creatorId, maxConfidence },
          "High confidence match found, auto-tagging creator"
        );

        videoCreatorsToInsert.push({ videoId, creatorId });

        const { detection: bestDetection, match: matchInfo } =
          groupDetections[0];

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
          matchedCreatorId: matchInfo.creator_id,
          matchConfidence: matchInfo.similarity,
          matchStatus: "confirmed" as const,
        });
      } else {
        const limit = env.FACE_MAX_PENDING_PER_VIDEO;
        const detectionsToSave = groupDetections.slice(0, limit);

        for (const matchedDetection of detectionsToSave) {
          const { detection, match: matchInfo } = matchedDetection;
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
            matchedCreatorId: matchInfo.creator_id,
            matchConfidence: matchInfo.similarity,
            matchStatus: matchStatus as any,
          });
        }
      }
    }

    await db.transaction(async (tx) => {
      await publicationContext?.guard(tx);

      if (videoCreatorsToInsert.length > 0) {
        await tx
          .insert(videoCreatorsTable)
          .values(videoCreatorsToInsert)
          .onConflictDoNothing();
      }

      if (detectionsToInsert.length > 0) {
        await tx.insert(videoFaceDetectionsTable).values(
          detectionsToInsert.map((detection) => ({
            ...detection,
            faceExtractionJobId: publicationContext?.runId ?? null,
            isPublished: !publicationContext,
          }))
        );
      }

      if (!publicationContext) return;

      await tx
        .update(videoFaceDetectionsTable)
        .set({ isPublished: false })
        .where(eq(videoFaceDetectionsTable.videoId, videoId));

      await tx
        .update(videoFaceDetectionsTable)
        .set({ isPublished: true })
        .where(
          and(
            eq(videoFaceDetectionsTable.videoId, videoId),
            eq(
              videoFaceDetectionsTable.faceExtractionJobId,
              publicationContext.runId
            )
          )
        );

      await tx
        .update(faceExtractionJobsTable)
        .set({ isPublished: false })
        .where(eq(faceExtractionJobsTable.videoId, videoId));

      const publishedRuns = await tx
        .update(faceExtractionJobsTable)
        .set({ isPublished: true })
        .where(
          and(
            eq(faceExtractionJobsTable.id, publicationContext.runId),
            eq(faceExtractionJobsTable.videoId, videoId)
          )
        )
        .returning({ id: faceExtractionJobsTable.id });

      if (publishedRuns.length !== 1) {
        throw new NotFoundError(
          `Face extraction run ${publicationContext.runId} not found for video ${videoId}`
        );
      }
    });
  }

  /**
   * Unified workflow for initial library scan.
   * Keeps one extraction pass for thumbnail + storyboard + faces.
   */
  async processVideo(
    videoId: number,
    videoPath: string,
    videoDuration: number
  ): Promise<void> {
    if (env.DEMO_MODE) return faceRecognitionDemoService.processVideo(videoId);
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
      "Frames extracted"
    );

    try {
      const thumbnailPercent = env.THUMBNAIL_POSITION_PERCENT;
      const targetSeconds = videoDuration * (thumbnailPercent / 100);
      const closestFrame = frameService.findClosestFrame(
        result.frames,
        targetSeconds
      );

      if (closestFrame) {
        await thumbnailsService.saveFromFrame(videoId, closestFrame);
        logger.info({ videoId }, "Thumbnail generated from extracted frame");
      }

      await storyboardsService.assembleFromFrames(
        videoId,
        result.frames,
        videoDuration
      );
      logger.info({ videoId }, "Storyboard assembled from extracted frames");

      const faceQueue = getDurableFaceExtractionQueue();
      await faceQueue.queueExtraction(videoId);
      logger.info({ videoId }, "Face extraction queued");
    } finally {
      try {
        await frameService.cleanupFrames(result.tempDirectory, {
          removeDirectory: true,
        });
      } catch (cleanupError) {
        logger.warn(
          { error: cleanupError, videoId },
          "Failed to clean shared video-processing frames"
        );
      }
    }
  }

  /**
   * Face-only workflow for on-demand endpoint.
   * Skips thumbnail/storyboard generation and uses face-optimized extraction settings.
   */
  async processFacesOnly(
    videoId: number,
    _videoPath: string,
    _videoDuration: number
  ): Promise<void> {
    if (env.DEMO_MODE)
      return faceRecognitionDemoService.processFacesOnly(videoId);
    logger.info({ videoId }, "Starting face-only processing");
    const faceQueue = getDurableFaceExtractionQueue();
    const queueStart = Date.now();
    await faceQueue.queueExtraction(videoId);
    await recordPerfStage(
      { scenario: "face", videoId, mode: "process_faces_only" },
      "queue_extraction",
      Date.now() - queueStart
    );
    logger.info({ videoId }, "Face-only extraction queued");
  }

  /**
   * Get face extraction job status
   */
  async getFaceExtractionJob(videoId: number) {
    if (env.DEMO_MODE)
      return faceRecognitionDemoService.getFaceExtractionJob(videoId);
    const job = await getDurableFaceExtractionQueue().getLatestJob(videoId);

    if (!job) {
      throw new NotFoundError(
        `Face extraction job not found for video: ${videoId}`
      );
    }

    return job;
  }

  /**
   * Clear the face extraction queue
   */
  async clearQueue(): Promise<void> {
    if (env.DEMO_MODE) return faceRecognitionDemoService.clearQueue();
    const queue = getDurableFaceExtractionQueue();
    await queue.clearQueue();
  }

  /**
   * Find videos containing a specific creator (by face)
   */
  async findVideosWithCreator(
    creatorId: number,
    minConfidence: number = env.FACE_SIMILARITY_THRESHOLD
  ): Promise<
    Array<{ videoId: number; detectionCount: number; avgConfidence: number }>
  > {
    if (env.DEMO_MODE)
      return faceRecognitionDemoService.findVideosWithCreator(
        creatorId,
        minConfidence
      );
    const query = sql`
      SELECT
        video_id,
        COUNT(*) as detection_count,
        AVG(match_confidence) as avg_confidence
      FROM ${videoFaceDetectionsTable}
      WHERE matched_creator_id = ${creatorId}
        AND is_published = true
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
