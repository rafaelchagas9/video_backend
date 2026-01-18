/**
 * Face Recognition Service
 * Main service for face recognition, embedding management, and similarity matching
 */

import { db } from '@/config/drizzle';
import { eq, sql, and, desc } from 'drizzle-orm';
import {
  creatorFaceEmbeddingsTable,
  videoFaceDetectionsTable,
  faceExtractionJobsTable,
  type NewCreatorFaceEmbedding,
  type CreatorFaceEmbedding,
  type VideoFaceDetection,
  videoCreatorsTable,
  creatorsTable,
} from '@/database/schema';
import { logger } from '@/utils/logger';
import { env } from '@/config/env';
import { NotFoundError } from '@/utils/errors';
import { getFaceRecognitionClient } from './face-recognition.client';
import { getFrameExtractionService } from '@/modules/frame-extraction';
import { getFaceExtractionQueue } from './face-extraction-queue.service';
import { thumbnailsService } from '@/modules/thumbnails/thumbnails.service';
import { storyboardsService } from '@/modules/storyboards/storyboards.service';
import type { SimilarityMatch } from './face-recognition.types';

export class FaceRecognitionService {
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
      throw new Error('No face detected in image');
    }

    if (result.faces.length > 1) {
      logger.warn(
        { count: result.faces.length },
        'Multiple faces detected, using first face',
      );
    }

    const face = result.faces[0];
    const embedding = JSON.stringify(face.embedding);

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
    };

    const inserted = await db
      .insert(creatorFaceEmbeddingsTable)
      .values(newEmbedding)
      .returning();

    logger.info(
      { creatorId, embeddingId: inserted[0].id },
      'Added creator face embedding',
    );

    return inserted[0];
  }

  /**
   * Get all face embeddings for a creator
   */
  async getCreatorEmbeddings(creatorId: number): Promise<CreatorFaceEmbedding[]> {
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
      .then(rows => rows[0]);

    if (!detection) {
      throw new NotFoundError(`Detection ${detectionId} not found`);
    }

    const { videoId } = detection;

    logger.info(
      { videoId, creatorId, detectionId },
      'Manually confirming face match - Auto-tagging and cleaning up',
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
      .then(rows => rows[0]);

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
        matchStatus: 'rejected',
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
    const embeddingString = `[${embedding.join(',')}]`;

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
   * Runs similarity search for all unmatched faces in a video
   */
  async autoMatchVideoFaces(
    videoId: number,
    similarityThreshold: number = env.FACE_SIMILARITY_THRESHOLD,
    autoTagThreshold: number = env.FACE_AUTO_TAG_THRESHOLD,
  ): Promise<void> {
    // Get all pending face detections
    const detections = await db
      .select()
      .from(videoFaceDetectionsTable)
      .where(
        and(
          eq(videoFaceDetectionsTable.videoId, videoId),
          eq(videoFaceDetectionsTable.matchStatus, 'pending'),
        ),
      );

    logger.info({ videoId, count: detections.length }, 'Auto-matching video faces');

    if (detections.length === 0) {
      return;
    }

    // Group matches by creator to robustly handle "multiple instances" check
    const creatorMatches = new Map<
      number,
      {
        creatorId: number;
        maxConfidence: number;
        detections: typeof detections;
      }
    >();

    // 1. Calculate matches for all detections
    for (const detection of detections) {
      try {
        const embedding = JSON.parse(detection.embedding);
        const matches = await this.findSimilarCreators(
          embedding,
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
          // Keep track of the highest confidence seen for this creator in this batch
          if (bestMatch.similarity > group.maxConfidence) {
            group.maxConfidence = bestMatch.similarity;
          }

          // Attach match info temporarily to the detection object for later use
          (detection as any)._matchInfo = bestMatch;
        } else {
          // No match found immediately mark as no_match
          await db
            .update(videoFaceDetectionsTable)
            .set({
              matchStatus: 'no_match',
              updatedAt: new Date(),
            })
            .where(eq(videoFaceDetectionsTable.id, detection.id));
        }
      } catch (error) {
        logger.error({ detectionId: detection.id, error }, 'Failed to compute match');
      }
    }

    // 2. Process groups
    for (const group of creatorMatches.values()) {
      const { creatorId, maxConfidence, detections: groupDetections } = group;

      // Check if ANY detection for this creator meets the auto-tag threshold
      if (maxConfidence >= autoTagThreshold) {
        logger.info(
          { videoId, creatorId, maxConfidence },
          'High confidence match found, auto-tagging creator and clearing detections',
        );

        // A. Tag the creator on the video
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
          .then(rows => rows[0]);

        if (!existing) {
          await db
            .insert(videoCreatorsTable)
            .values({
              videoId,
              creatorId,
            })
            .onConflictDoNothing();
        }

        // B. DELETE ALL detections for this creator in this video
        // This includes likely the ones we just found, plus any others that might exist in DB
        // Query to delete by matchedCreatorId OR if we are processing them now.
        // Easier: Delete from table where videoId AND (matchedCreatorId = creatorId OR id IN ids_we_matched_to_this_creator)

        // For stricter cleanup as requested: "remove any other detect faces on that video for that actor"
        // We delete ALL faces that are either:
        // 1. Already matched to this creator (confirmed/pending/rejected)
        // 2. In our current batch and matched to this creator

        const currentBatchIds = groupDetections.map(d => d.id);

        await db
          .delete(videoFaceDetectionsTable)
          .where(
            and(
              eq(videoFaceDetectionsTable.videoId, videoId),
              sql`(${videoFaceDetectionsTable.matchedCreatorId} = ${creatorId} OR ${videoFaceDetectionsTable.id} IN ${currentBatchIds})`,
            ),
          );
      } else {
        // Low confidence - just update the records as pending/confirmed based on own score
        // (Note: The original logic had a binary "confirmed" vs "pending" based on autoTagThreshold too.
        // We keep that, but since we didn't hit the "Delete" path, we persist them.)
        for (const detection of groupDetections) {
          const matchInfo = (detection as any)._matchInfo;
          const matchStatus =
            matchInfo.similarity >= autoTagThreshold ? 'confirmed' : 'pending';

          await db
            .update(videoFaceDetectionsTable)
            .set({
              matchedCreatorId: matchInfo.creator_id,
              matchConfidence: matchInfo.similarity,
              matchStatus,
              updatedAt: new Date(),
            })
            .where(eq(videoFaceDetectionsTable.id, detection.id));
        }
      }
    }
  }

  /**
   * Orchestrate complete face recognition workflow for a video
   * 1. Extract frames
   * 2. Generate thumbnail and storyboard from frames
   * 3. Queue face extraction
   */
  async processVideo(
    videoId: number,
    videoPath: string,
    videoDuration: number,
  ): Promise<void> {
    logger.info({ videoId }, 'Starting unified video processing');

    // Extract frames (unified pass)
    const frameService = getFrameExtractionService();
    const result = await frameService.extractFrames({
      videoId,
      videoPath,
      videoDuration,
      intervalSeconds: 10, // Extract frame every 10 seconds
    });

    logger.info(
      { videoId, framesExtracted: result.totalFrames },
      'Frames extracted',
    );

    try {
      // Generate thumbnail from closest frame to target position
      const thumbnailPercent = env.THUMBNAIL_POSITION_PERCENT;
      const targetSeconds = videoDuration * (thumbnailPercent / 100);
      const closestFrame = frameService.findClosestFrame(
        result.frames,
        targetSeconds,
      );

      if (closestFrame) {
        await thumbnailsService.saveFromFrame(videoId, closestFrame);
        logger.info({ videoId }, 'Thumbnail generated from extracted frame');
      }

      // Generate storyboard from all frames
      await storyboardsService.assembleFromFrames(
        videoId,
        result.frames,
        videoDuration,
      );
      logger.info({ videoId }, 'Storyboard assembled from extracted frames');

      // Queue face extraction
      const faceQueue = getFaceExtractionQueue();
      await faceQueue.queueExtraction(videoId, result.frames);
      logger.info({ videoId }, 'Face extraction queued');

      // Note: Frames will be cleaned up by the face queue after processing
    } catch (error) {
      // Clean up frames on error
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
      .then(rows => rows[0] || null);

    if (!job) {
      throw new NotFoundError(`Face extraction job not found for video: ${videoId}`);
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
  ): Promise<Array<{ videoId: number; detectionCount: number; avgConfidence: number }>> {
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
