/**
 * Face Images Service
 * Manages storage and lazy generation of cropped face thumbnails
 * from video face detections
 */

import { join } from 'path';
import { existsSync, mkdirSync, unlinkSync, statSync } from 'fs';
import { eq } from 'drizzle-orm';
import { db } from '@/config/drizzle';
import { faceImagesTable, videoFaceDetectionsTable } from '@/database/schema';
import type { FaceImage, NewFaceImage, VideoFaceDetection } from '@/database/schema';
import { env } from '@/config/env';
import { NotFoundError, InternalServerError } from '@/utils/errors';
import { logger } from '@/utils/logger';
import { cropFaceThumbnail } from '@/utils/image-processing';
import { getFrameExtractionService } from '@/modules/frame-extraction/frame-extraction.service';
import { videosService } from '@/modules/videos/videos.service';

export class FaceImagesService {
  private facesDir: string;

  constructor() {
    this.facesDir = env.FACES_DIR || './data/faces';

    // Ensure faces directory exists
    if (!existsSync(this.facesDir)) {
      mkdirSync(this.facesDir, { recursive: true });
      logger.info({ facesDir: this.facesDir }, 'Created faces directory');
    }
  }


  /**
   * Get face image by detection ID
   * Returns null if not yet generated
   */
  async getByDetectionId(detectionId: number): Promise<FaceImage | null> {
    const result = await db
      .select()
      .from(faceImagesTable)
      .where(eq(faceImagesTable.detectionId, detectionId))
      .limit(1);

    return result[0] || null;
  }

  /**
   * Get face image by primary key
   */
  async findById(id: number): Promise<FaceImage> {
    const result = await db
      .select()
      .from(faceImagesTable)
      .where(eq(faceImagesTable.id, id))
      .limit(1);

    if (!result[0]) {
      throw new NotFoundError('Face image not found');
    }

    return result[0];
  }

  /**
   * Generate face image from detection
   * Extracts frame, crops to face bounding box, and stores
   */
  async generateFromDetection(detectionId: number): Promise<FaceImage> {
    logger.info({ detectionId }, 'Generating face image from detection');

    // Get detection data
    const detection = await this.getDetection(detectionId);

    // Get video data for frame extraction
    const video = await videosService.findById(detection.videoId);

    if (!video.width || !video.height) {
      throw new InternalServerError('Video dimensions not available for face cropping');
    }

    // Create temp directory for frame extraction
    const tempDir = join(env.FRAME_EXTRACTION_TEMP_DIR || '/tmp', `face_gen_${detectionId}_${Date.now()}`);
    if (!existsSync(tempDir)) {
      mkdirSync(tempDir, { recursive: true });
    }

    try {
      // Extract frame at detection timestamp
      const frameService = getFrameExtractionService();
      const framePath = await frameService.extractFrame({
        videoPath: video.file_path,
        timestampSeconds: detection.timestampSeconds,
        outputDir: tempDir,
        outputFormat: env.FRAME_EXTRACTION_FORMAT,
        quality: env.FRAME_EXTRACTION_QUALITY,
      });

      logger.debug({ framePath, detectionId }, 'Frame extracted for face cropping');

      // Bounding box is already in pixel coordinates
      const bbox = [
        Math.round(detection.bboxX1),
        Math.round(detection.bboxY1),
        Math.round(detection.bboxX2),
        Math.round(detection.bboxY2),
      ];

      // Generate output filename
      const format = env.FACE_THUMBNAIL_FORMAT;
      const filename = `detection_${detectionId}_${Date.now()}.${format}`;
      const outputPath = join(this.facesDir, filename);

      // Crop face from frame
      const paddingScale = env.FACE_IMAGE_PADDING || 0.5;
      await cropFaceThumbnail({
        inputPath: framePath,
        outputPath,
        faceBox: bbox,
        imageWidth: video.width,
        imageHeight: video.height,
        paddingScale,
      });

      logger.debug({ outputPath, detectionId }, 'Face image cropped and saved');

      // Get file stats
      const stats = statSync(outputPath);
      const targetSize = env.FACE_THUMBNAIL_SIZE;

      // Save to database
      const newFaceImage: NewFaceImage = {
        detectionId,
        filePath: outputPath,
        fileSizeBytes: stats.size,
        width: targetSize,
        height: targetSize,
      };

      const result = await db
        .insert(faceImagesTable)
        .values(newFaceImage)
        .returning();

      logger.info({ faceImageId: result[0].id, detectionId }, 'Face image generated successfully');

      // Cleanup temp directory
      this.cleanupTempDir(tempDir);

      return result[0];
    } catch (error) {
      // Cleanup temp directory on error
      this.cleanupTempDir(tempDir);
      throw error;
    }
  }

  /**
   * Get or generate face image (lazy generation pattern)
   * This is the primary method used by the API
   */
  async getOrGenerateByDetectionId(detectionId: number): Promise<FaceImage> {
    // Check if already exists
    const existing = await this.getByDetectionId(detectionId);
    if (existing) {
      return existing;
    }

    // Generate if not exists
    return this.generateFromDetection(detectionId);
  }

  /**
   * Delete face image by detection ID
   * Removes both file and database record
   */
  async deleteByDetectionId(detectionId: number): Promise<void> {
    const faceImage = await this.getByDetectionId(detectionId);

    if (!faceImage) {
      return; // Already deleted or never generated
    }

    // Delete file if exists
    try {
      if (existsSync(faceImage.filePath)) {
        unlinkSync(faceImage.filePath);
        logger.debug({ filePath: faceImage.filePath }, 'Face image file deleted');
      }
    } catch (error) {
      logger.warn({ error, filePath: faceImage.filePath }, 'Failed to delete face image file');
    }

    // Delete database record
    await db
      .delete(faceImagesTable)
      .where(eq(faceImagesTable.detectionId, detectionId));

    logger.info({ detectionId }, 'Face image deleted');
  }

  /**
   * Delete face image by primary key
   */
  async deleteById(id: number): Promise<void> {
    const faceImage = await this.findById(id);
    await this.deleteByDetectionId(faceImage.detectionId);
  }

  /**
   * Helper: Get detection from database
   */
  private async getDetection(detectionId: number): Promise<VideoFaceDetection> {
    const result = await db
      .select()
      .from(videoFaceDetectionsTable)
      .where(eq(videoFaceDetectionsTable.id, detectionId))
      .limit(1);

    if (!result[0]) {
      throw new NotFoundError('Face detection not found');
    }

    return result[0];
  }

  /**
   * Helper: Cleanup temporary directory
   */
  private cleanupTempDir(tempDir: string): void {
    try {
      if (existsSync(tempDir)) {
        const frameService = getFrameExtractionService();
        frameService.cleanupFrames(tempDir, { removeDirectory: true });
      }
    } catch (error) {
      logger.warn({ error, tempDir }, 'Failed to cleanup temp directory');
    }
  }
}

// Singleton instance
let serviceInstance: FaceImagesService | null = null;

export function getFaceImagesService(): FaceImagesService {
  if (!serviceInstance) {
    serviceInstance = new FaceImagesService();
  }
  return serviceInstance;
}

/**
 * For testing - reset singleton
 */
export function resetFaceImagesService(): void {
  serviceInstance = null;
}
