/**
 * Video conversion service with GPU-accelerated FFmpeg encoding (VAAPI)
 */
import { join, basename, extname } from 'path';
import { existsSync, mkdirSync, statSync } from 'fs';
import { spawn } from 'child_process';
import { getDatabase } from '@/config/database';
import { env } from '@/config/env';
import { NotFoundError, BadRequestError, InternalServerError } from '@/utils/errors';
import { videosService } from '@/modules/videos/videos.service';
import { getPreset, listPresets, MIN_HEIGHT_FOR_720P, type ConversionPreset } from '@/config/presets';
import { conversionQueue } from './conversion.queue';
import { websocketService } from '@/modules/websocket/websocket';
import { logger } from '@/utils/logger';
import type { 
  ConversionJob, 
  CreateConversionJobInput, 
  QueueJobPayload,
  ConversionEvent,
} from './conversion.types';

export class ConversionService {
  private get db() {
    return getDatabase();
  }

  constructor() {
    // Ensure converted videos directory exists
    if (!existsSync(env.CONVERTED_VIDEOS_DIR)) {
      mkdirSync(env.CONVERTED_VIDEOS_DIR, { recursive: true });
    }

    // Set up queue processor
    conversionQueue.setProcessor(this.processJob.bind(this));
  }

  /**
   * Start the conversion queue
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
    const targetResolution = this.calculateTargetResolution(
      video.width,
      video.height,
      preset
    );

    // Generate output path
    const outputFileName = this.generateOutputFileName(video.file_name, preset);
    const outputPath = join(env.CONVERTED_VIDEOS_DIR, outputFileName);

    // Check if same job already exists and is pending/processing
    const existing = this.db
      .prepare(
        `SELECT id, status FROM conversion_jobs 
         WHERE video_id = ? AND preset = ? AND status IN ('pending', 'processing')`
      )
      .get(input.video_id, input.preset) as { id: number; status: string } | undefined;

    if (existing) {
      throw new BadRequestError(
        `Conversion job already ${existing.status} for this video with preset ${input.preset}`
      );
    }

    // Insert job record
    const result = this.db
      .prepare(
        `INSERT INTO conversion_jobs (
          video_id, status, preset, target_resolution, codec, output_path
        ) VALUES (?, 'pending', ?, ?, ?, ?)`
      )
      .run(
        input.video_id,
        input.preset,
        targetResolution,
        preset.codec,
        outputPath
      );

    const jobId = result.lastInsertRowid as number;
    const job = await this.findById(jobId);

    // Add to queue
    const queuePayload: QueueJobPayload = {
      jobId,
      videoId: input.video_id,
      preset: input.preset,
      inputPath: video.file_path,
      outputPath,
      createdAt: new Date().toISOString(),
    };

    await conversionQueue.enqueue(queuePayload);

    return job;
  }

  /**
   * Process a conversion job (called by queue)
   */
  private async processJob(payload: QueueJobPayload): Promise<void> {
    const { jobId, videoId, preset: presetId, inputPath, outputPath } = payload;
    
    try {
      // Update job status to processing
      this.db.prepare(
        `UPDATE conversion_jobs SET status = 'processing', started_at = datetime('now') WHERE id = ?`
      ).run(jobId);

      // Notify via WebSocket
      this.emitEvent({
        type: 'conversion:started',
        jobId,
        videoId,
        preset: presetId,
      });

      const preset = getPreset(presetId)!;
      const job = await this.findById(jobId);

      // Build and run FFmpeg command
      await this.runFfmpeg(jobId, inputPath, outputPath, preset, job.target_resolution);

      // Get output file size
      const stats = statSync(outputPath);

      // Update job as completed
      this.db.prepare(
        `UPDATE conversion_jobs 
         SET status = 'completed', progress_percent = 100, 
             output_size_bytes = ?, completed_at = datetime('now')
         WHERE id = ?`
      ).run(stats.size, jobId);

      // Notify via WebSocket
      this.emitEvent({
        type: 'conversion:completed',
        jobId,
        videoId,
        preset: presetId,
        progress: 100,
        outputPath,
      });

      logger.info({ jobId, outputPath, size: stats.size }, 'Conversion completed');

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      // Update job as failed
      this.db.prepare(
        `UPDATE conversion_jobs 
         SET status = 'failed', error_message = ?, completed_at = datetime('now')
         WHERE id = ?`
      ).run(errorMessage, jobId);

      // Notify via WebSocket
      this.emitEvent({
        type: 'conversion:failed',
        jobId,
        videoId,
        preset: presetId,
        error: errorMessage,
      });

      logger.error({ jobId, error: errorMessage }, 'Conversion failed');
      throw error;
    }
  }

  /**
   * Run FFmpeg with VAAPI GPU acceleration
   */
  private runFfmpeg(
    jobId: number,
    inputPath: string,
    outputPath: string,
    preset: ConversionPreset,
    targetResolution: string | null
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      // Build video filter for VAAPI
      let vfFilter: string;
      
      if (targetResolution === 'original' || !targetResolution) {
        // Keep original resolution
        vfFilter = 'format=nv12|vaapi,hwupload';
      } else {
        // Parse target resolution (e.g., "1920x1080" or "1920x-2")
        const [width] = targetResolution.split('x');
        // Use -2 for height to preserve aspect ratio (divisible by 2)
        vfFilter = `format=nv12|vaapi,hwupload,scale_vaapi=w=${width}:h=-2`;
      }

      const args = [
        '-vaapi_device', env.VAAPI_DEVICE,
        '-i', inputPath,
        '-vf', vfFilter,
        '-c:v', preset.codec,
        '-qp', preset.qp.toString(),
        '-c:a', 'aac',
        '-b:a', preset.audioBitrate,
        '-y', // Overwrite output
        '-progress', 'pipe:1', // Output progress to stdout
        outputPath,
      ];

      logger.debug({ jobId, args }, 'Starting FFmpeg');

      const ffmpeg = spawn(env.FFMPEG_PATH, args);
      let duration = 0;
      let lastProgress = 0;

      // First, get video duration via ffprobe
      this.getVideoDuration(inputPath).then((d) => {
        duration = d;
      }).catch(() => {
        // If we can't get duration, progress updates won't work but conversion continues
      });

      ffmpeg.stdout.on('data', (data: Buffer) => {
        const output = data.toString();
        
        // Parse progress from FFmpeg output
        const timeMatch = output.match(/out_time_ms=(\d+)/);
        if (timeMatch && duration > 0) {
          const currentMs = parseInt(timeMatch[1], 10) / 1000; // Convert to seconds
          const progress = Math.min(99, Math.round((currentMs / duration) * 100));
          
          // Only update if progress changed significantly (avoid too many updates)
          if (progress > lastProgress + 2) {
            lastProgress = progress;
            
            // Update database
            this.db.prepare(
              'UPDATE conversion_jobs SET progress_percent = ? WHERE id = ?'
            ).run(progress, jobId);

            // Emit progress event
            this.findById(jobId).then((job) => {
              this.emitEvent({
                type: 'conversion:progress',
                jobId,
                videoId: job.video_id,
                preset: job.preset,
                progress,
              });
            });
          }
        }
      });

      ffmpeg.stderr.on('data', (data: Buffer) => {
        // FFmpeg outputs most info to stderr, log at debug level
        logger.debug({ jobId, ffmpeg: data.toString().trim() }, 'FFmpeg output');
      });

      ffmpeg.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`FFmpeg exited with code ${code}`));
        }
      });

      ffmpeg.on('error', (error) => {
        reject(new InternalServerError(`FFmpeg error: ${error.message}`));
      });
    });
  }

  /**
   * Get video duration in seconds using FFprobe
   */
  private getVideoDuration(inputPath: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const args = [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        inputPath,
      ];

      const ffprobe = spawn(env.FFPROBE_PATH, args);
      let output = '';

      ffprobe.stdout.on('data', (data: Buffer) => {
        output += data.toString();
      });

      ffprobe.on('close', (code) => {
        if (code === 0) {
          const duration = parseFloat(output.trim());
          if (!isNaN(duration)) {
            resolve(duration);
          } else {
            reject(new Error('Failed to parse duration'));
          }
        } else {
          reject(new Error(`FFprobe exited with code ${code}`));
        }
      });

      ffprobe.on('error', reject);
    });
  }

  /**
   * Calculate target resolution based on video dimensions and preset
   */
  private calculateTargetResolution(
    width: number | null,
    height: number | null,
    preset: ConversionPreset
  ): string {
    // If preset wants original, always keep original
    if (preset.targetWidth === null) {
      return 'original';
    }

    // If we don't know the video dimensions, use preset target
    if (!width || !height) {
      return `${preset.targetWidth}x-2`;
    }

    // If video is smaller than 720p, keep original
    if (height < MIN_HEIGHT_FOR_720P) {
      return 'original';
    }

    // If video is smaller than target width, keep original
    if (width <= preset.targetWidth) {
      return 'original';
    }

    // Target width with auto height (aspect ratio preserved)
    return `${preset.targetWidth}x-2`;
  }

  /**
   * Generate output filename
   */
  private generateOutputFileName(originalName: string, preset: ConversionPreset): string {
    const baseName = basename(originalName, extname(originalName));
    const timestamp = Date.now();
    return `${baseName}_${preset.id}_${timestamp}.mkv`;
  }

  /**
   * Emit WebSocket event
   */
  private emitEvent(event: ConversionEvent): void {
    try {
      websocketService.broadcast(event);
    } catch (error) {
      logger.error({ error }, 'Failed to emit WebSocket event');
    }
  }

  /**
   * Find job by ID
   */
  async findById(id: number): Promise<ConversionJob> {
    const job = this.db
      .prepare('SELECT * FROM conversion_jobs WHERE id = ?')
      .get(id) as ConversionJob | undefined;

    if (!job) {
      throw new NotFoundError(`Conversion job not found: ${id}`);
    }

    return job;
  }

  /**
   * List jobs for a video
   */
  async listByVideoId(videoId: number): Promise<ConversionJob[]> {
    return this.db
      .prepare('SELECT * FROM conversion_jobs WHERE video_id = ? ORDER BY created_at DESC')
      .all(videoId) as ConversionJob[];
  }

  /**
   * Cancel a pending job
   */
  async cancel(id: number): Promise<ConversionJob> {
    const job = await this.findById(id);

    if (job.status !== 'pending') {
      throw new BadRequestError(`Cannot cancel job in ${job.status} status`);
    }

    this.db.prepare(
      `UPDATE conversion_jobs SET status = 'cancelled', completed_at = datetime('now') WHERE id = ?`
    ).run(id);

    return this.findById(id);
  }

  /**
   * Delete a job (only completed/failed/cancelled)
   */
  async delete(id: number): Promise<void> {
    const job = await this.findById(id);

    if (job.status === 'pending' || job.status === 'processing') {
      throw new BadRequestError(`Cannot delete job in ${job.status} status`);
    }

    // Delete output file if exists
    if (job.output_path && existsSync(job.output_path)) {
      try {
        const fs = await import('fs');
        fs.unlinkSync(job.output_path);
      } catch (error) {
        logger.warn({ error, path: job.output_path }, 'Failed to delete output file');
      }
    }

    this.db.prepare('DELETE FROM conversion_jobs WHERE id = ?').run(id);
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
    return conversionQueue.getStatus();
  }
}

export const conversionService = new ConversionService();
