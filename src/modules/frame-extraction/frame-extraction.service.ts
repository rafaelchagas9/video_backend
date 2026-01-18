/**
 * Frame Extraction Service
 * Unified service for extracting frames from videos in a single FFmpeg pass
 * Frames are used by thumbnail, storyboard, and face recognition services
 */

import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { unlink, readdir, rmdir, stat as statAsync } from 'fs/promises';
import ffmpeg from 'fluent-ffmpeg';
import { logger } from '@/utils/logger';
import { InternalServerError } from '@/utils/errors';
import type {
  FrameExtractionOptions,
  FrameExtractionResult,
  ExtractedFrame,
  FrameCleanupOptions,
} from './frame-extraction.types';

export class FrameExtractionService {
  private defaultTempDir: string;
  private defaultFormat: 'jpg' | 'webp' | 'png';
  private defaultQuality: number;

  constructor(
    tempDir: string = '/dev/shm',
    format: 'jpg' | 'webp' | 'png' = 'jpg',
    quality: number = 90,
  ) {
    this.defaultTempDir = tempDir;
    this.defaultFormat = format;
    this.defaultQuality = quality;

    // Ensure temp directory exists (but don't fail if /dev/shm doesn't)
    if (!existsSync(this.defaultTempDir)) {
      logger.warn(
        { tempDir: this.defaultTempDir },
        'Default temp directory does not exist, will use fallback',
      );
    }
  }

  /**
   * Extract frames from a video at regular intervals
   * Returns paths to extracted frames for processing by other services
   */
  async extractFrames(options: FrameExtractionOptions): Promise<FrameExtractionResult> {
    const startTime = Date.now();

    const {
      videoId,
      videoPath,
      videoDuration,
      intervalSeconds,
      targetWidth,
      targetHeight,
      outputFormat = this.defaultFormat,
      quality = this.defaultQuality,
      tempDir = this.defaultTempDir,
      prefix = 'frame',
    } = options;

    // Calculate number of frames to extract
    const totalFrames = Math.ceil(videoDuration / intervalSeconds);

    // Create temp directory for this video's frames
    const videoTempDir = this.createTempDirectory(tempDir, videoId);

    logger.info(
      { videoId, totalFrames, intervalSeconds, outputFormat },
      'Starting frame extraction',
    );

    try {
      // Extract frames using FFmpeg
      await this.runFfmpegExtraction({
        videoPath,
        outputDir: videoTempDir,
        intervalSeconds,
        targetWidth,
        targetHeight,
        outputFormat,
        quality,
        prefix,
      });

      // Collect extracted frame metadata
      const frames = await this.collectFrameMetadata(
        videoTempDir,
        prefix,
        outputFormat,
        intervalSeconds,
        totalFrames,
      );

      const extractionTimeMs = Date.now() - startTime;

      logger.info(
        { videoId, framesExtracted: frames.length, timeMs: extractionTimeMs },
        'Frame extraction completed',
      );

      return {
        videoId,
        frames,
        totalFrames: frames.length,
        extractionTimeMs,
        tempDirectory: videoTempDir,
      };
    } catch (error) {
      logger.error({ error, videoId }, 'Frame extraction failed');
      // Clean up temp directory on failure
      await this.cleanupFrames(videoTempDir, { removeDirectory: true });
      throw new InternalServerError(
        `Frame extraction failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Create a temporary directory for frames
   * Falls back to /tmp if specified directory is unavailable
   */
  private createTempDirectory(baseDir: string, videoId: number): string {
    let tempDir = baseDir;

    // Check if base directory exists, fallback to /tmp if not
    if (!existsSync(baseDir)) {
      logger.warn(
        { requestedDir: baseDir, fallback: '/tmp' },
        'Temp directory not available, using fallback',
      );
      tempDir = '/tmp';
    }

    // Create unique directory for this video's frames
    const timestamp = Date.now();
    const videoTempDir = join(tempDir, `frames_${videoId}_${timestamp}`);

    mkdirSync(videoTempDir, { recursive: true });

    logger.debug({ directory: videoTempDir }, 'Created temp directory for frames');

    return videoTempDir;
  }

  /**
   * Run FFmpeg to extract frames at intervals
   */
  private async runFfmpegExtraction(params: {
    videoPath: string;
    outputDir: string;
    intervalSeconds: number;
    targetWidth?: number;
    targetHeight?: number;
    outputFormat: string;
    quality: number;
    prefix: string;
  }): Promise<void> {
    const {
      videoPath,
      outputDir,
      intervalSeconds,
      targetWidth,
      targetHeight,
      outputFormat,
      quality,
      prefix,
    } = params;

    // Build scale filter if dimensions specified
    let scaleFilter = '';
    if (targetWidth && targetHeight) {
      scaleFilter = `scale=${targetWidth}:${targetHeight}`;
    } else if (targetWidth) {
      scaleFilter = `scale=${targetWidth}:-1`;
    } else if (targetHeight) {
      scaleFilter = `scale=-1:${targetHeight}`;
    }

    // Build complete filter chain
    const filters: string[] = [];
    filters.push(`fps=1/${intervalSeconds}`);
    if (scaleFilter) {
      filters.push(scaleFilter);
    }
    const filterChain = filters.join(',');

    // Output filename pattern
    const outputPattern = join(outputDir, `${prefix}_%04d.${outputFormat}`);

    // Quality options based on format
    const qualityOptions = this.getQualityOptions(outputFormat, quality);

    return new Promise<void>((resolve, reject) => {
      ffmpeg(videoPath)
        .outputOptions([
          '-vf',
          filterChain,
          '-vsync',
          'vfr', // Variable frame rate to handle exact intervals
          '-an', // No audio
          '-sn', // No subtitles
          '-dn', // No data streams
          ...qualityOptions,
        ])
        .output(outputPattern)
        .on('end', () => {
          logger.debug({ outputPattern }, 'FFmpeg frame extraction completed');
          resolve();
        })
        .on('error', (err) => {
          logger.error({ error: err, videoPath }, 'FFmpeg frame extraction error');
          reject(err);
        })
        .run();
    });
  }

  /**
   * Get quality options for FFmpeg based on output format
   */
  private getQualityOptions(format: string, quality: number): string[] {
    if (format === 'webp') {
      return ['-q:v', quality.toString()];
    }

    if (format === 'png') {
      // PNG compression level (0-9, lower is faster but larger)
      const compressionLevel = Math.round(9 - (quality / 100) * 9);
      return ['-compression_level', compressionLevel.toString()];
    }

    // JPEG quality (qscale 2-31, lower is better)
    const jpegQuality = Math.round(2 + ((100 - quality) / 100) * 29);
    return ['-qscale:v', jpegQuality.toString()];
  }

  /**
   * Collect metadata for extracted frames
   */
  private async collectFrameMetadata(
    directory: string,
    prefix: string,
    format: string,
    intervalSeconds: number,
    expectedCount: number,
  ): Promise<ExtractedFrame[]> {
    const files = await readdir(directory);
    const frameFiles = files
      .filter(f => f.startsWith(prefix) && f.endsWith(`.${format}`))
      .sort(); // Sort to ensure sequential order

    const frames: ExtractedFrame[] = [];

    for (let i = 0; i < frameFiles.length; i++) {
      const filePath = join(directory, frameFiles[i]);
      const stats = await statAsync(filePath);

      // We don't extract actual dimensions here (would require image library)
      // Services that need dimensions should read them when processing
      const frame: ExtractedFrame = {
        filePath,
        timestampSeconds: i * intervalSeconds,
        frameIndex: i,
        width: 0, // Will be filled by services that read the image
        height: 0,
      };

      frames.push(frame);
    }

    if (frames.length < expectedCount) {
      logger.warn(
        { expected: expectedCount, actual: frames.length },
        'Fewer frames extracted than expected',
      );
    }

    return frames;
  }

  /**
   * Clean up extracted frames
   */
  async cleanupFrames(
    directory: string,
    options: FrameCleanupOptions = {},
  ): Promise<void> {
    const { removeDirectory = false, keepFiles = [] } = options;

    try {
      if (!existsSync(directory)) {
        return;
      }

      const files = await readdir(directory);

      // Delete individual files
      for (const file of files) {
        const filePath = join(directory, file);

        if (keepFiles.includes(filePath)) {
          continue; // Skip files marked to keep
        }

        try {
          await unlink(filePath);
        } catch (error) {
          logger.warn({ file: filePath, error }, 'Failed to delete frame file');
        }
      }

      // Remove directory if requested
      if (removeDirectory) {
        try {
          await rmdir(directory);
          logger.debug({ directory }, 'Removed frame temp directory');
        } catch (error) {
          logger.warn({ directory, error }, 'Failed to remove temp directory');
        }
      }
    } catch (error) {
      logger.error({ error, directory }, 'Frame cleanup failed');
    }
  }

  /**
   * Get the closest frame to a target timestamp
   * Useful for thumbnail generation
   */
  findClosestFrame(
    frames: ExtractedFrame[],
    targetSeconds: number,
    maxDeviationSeconds: number = 5,
  ): ExtractedFrame | null {
    if (frames.length === 0) {
      return null;
    }

    let closestFrame = frames[0];
    let minDifference = Math.abs(frames[0].timestampSeconds - targetSeconds);

    for (const frame of frames) {
      const difference = Math.abs(frame.timestampSeconds - targetSeconds);

      if (difference < minDifference) {
        minDifference = difference;
        closestFrame = frame;
      }
    }

    // Check if closest frame is within acceptable deviation
    if (minDifference > maxDeviationSeconds) {
      logger.warn(
        { targetSeconds, closestFrame: closestFrame.timestampSeconds, deviation: minDifference },
        'Closest frame exceeds max deviation',
      );
      return null;
    }

    return closestFrame;
  }
}

// Singleton instance
let serviceInstance: FrameExtractionService | null = null;

export function getFrameExtractionService(): FrameExtractionService {
  if (!serviceInstance) {
    // Will be configured from env in next phase
    const tempDir = process.env.FRAME_EXTRACTION_TEMP_DIR || '/dev/shm';
    const format = (process.env.FRAME_EXTRACTION_FORMAT || 'jpg') as 'jpg' | 'webp' | 'png';
    const quality = parseInt(process.env.FRAME_EXTRACTION_QUALITY || '90', 10);

    serviceInstance = new FrameExtractionService(tempDir, format, quality);
  }
  return serviceInstance;
}

/**
 * For testing - reset singleton
 */
export function resetFrameExtractionService(): void {
  serviceInstance = null;
}
