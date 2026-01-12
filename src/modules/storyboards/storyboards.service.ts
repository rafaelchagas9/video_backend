import { join } from 'path';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import ffmpeg from 'fluent-ffmpeg';
import { getDatabase } from '@/config/database';
import { env } from '@/config/env';
import { NotFoundError, InternalServerError } from '@/utils/errors';
import { videosService } from '@/modules/videos/videos.service';
import { logger } from '@/utils/logger';
import type { Storyboard, GenerateStoryboardInput } from './storyboards.types';
import { copyFile, unlink, stat, readFile } from 'fs/promises';
import { freemem } from 'os';

interface SpriteSheetOptions {
  inputPath: string;
  outputPath: string;
  tileWidth: number;
  tileHeight: number;
  intervalSeconds: number;
  cols: number;
  rows: number;
  videoFps?: number; // Needed for select filter fallback
}

export class StoryboardsService {
  private get db() {
    return getDatabase();
  }

  // Queue system for sequential processing
  private processingVideoId: number | null = null;
  private pendingQueue: number[] = [];
  private isProcessing = false;

  constructor() {
    // Ensure storyboards directory exists
    if (!existsSync(env.STORYBOARDS_DIR)) {
      mkdirSync(env.STORYBOARDS_DIR, { recursive: true });
    }
  }

  /**
   * Queue a storyboard generation job.
   * - If already processing this video, skip.
   * - If already in queue, skip.
   * - Otherwise add to queue and start processing if not already running.
   */
  async queueGenerate(videoId: number, input?: GenerateStoryboardInput): Promise<void> {
    // Skip if this video is currently being processed
    if (this.processingVideoId === videoId) {
      logger.debug({ videoId }, 'Storyboard generation already in progress, skipping');
      return;
    }

    // Skip if already in queue
    if (this.pendingQueue.includes(videoId)) {
      logger.debug({ videoId }, 'Storyboard generation already queued, skipping');
      return;
    }

    // Check if storyboard already exists
    const existing = await this.findByVideoId(videoId);
    if (existing) {
      logger.debug({ videoId }, 'Storyboard already exists, skipping');
      return;
    }

    // Add to queue
    this.pendingQueue.push(videoId);
    logger.info({ videoId, queueLength: this.pendingQueue.length }, 'Storyboard generation queued');

    // Start processing if not already running
    if (!this.isProcessing) {
      this.processQueue();
    }
  }

  /**
   * Process the generation queue sequentially.
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing) return;
    
    this.isProcessing = true;

    while (this.pendingQueue.length > 0) {
      const videoId = this.pendingQueue.shift()!;
      this.processingVideoId = videoId;

      try {
        // Double-check storyboard doesn't exist (may have been created by another process)
        const existing = await this.findByVideoId(videoId);
        if (!existing) {
          logger.info({ videoId, remaining: this.pendingQueue.length }, 'Processing storyboard generation');
          
          // Import websocket service for notifications
          const { websocketService } = await import('@/modules/websocket/websocket');
          
          websocketService.broadcastToAuthenticated({
            type: 'storyboard:generating',
            payload: { videoId, message: 'Generating storyboard thumbnails...' },
            timestamp: new Date().toISOString(),
          });

          await this.generate(videoId);

          websocketService.broadcastToAuthenticated({
            type: 'storyboard:ready',
            payload: { videoId, message: 'Storyboard thumbnails ready' },
            timestamp: new Date().toISOString(),
          });
        }
      } catch (error) {
        logger.error({ videoId, error }, 'Failed to generate storyboard');
        
        const { websocketService } = await import('@/modules/websocket/websocket');
        websocketService.broadcastToAuthenticated({
          type: 'storyboard:error',
          payload: {
            videoId,
            message: 'Failed to generate storyboard',
            error: error instanceof Error ? error.message : String(error),
          },
          timestamp: new Date().toISOString(),
        });
      } finally {
        this.processingVideoId = null;
      }
    }

    this.isProcessing = false;
  }

  /**
   * Generate a storyboard sprite sheet and VTT file for a video.
   * Uses FFmpeg to extract frames at intervals and tile them into a single image.
   */
  async generate(videoId: number, input?: GenerateStoryboardInput): Promise<Storyboard> {
    const video = await videosService.findById(videoId);

    // Delete existing storyboard if present
    const existing = this.db
      .prepare('SELECT * FROM storyboards WHERE video_id = ?')
      .get(videoId) as Storyboard | undefined;

    if (existing) {
      await this.delete(videoId);
    }

    // Use input overrides or env defaults
    const tileWidth = input?.tileWidth ?? env.STORYBOARD_TILE_WIDTH;
    const tileHeight = input?.tileHeight ?? env.STORYBOARD_TILE_HEIGHT;
    const intervalSeconds = input?.intervalSeconds ?? env.STORYBOARD_INTERVAL_SECONDS;

    if (!video.duration_seconds || video.duration_seconds <= 0) {
      throw new InternalServerError('Video duration not available for storyboard generation');
    }

    // Calculate number of tiles needed
    const tileCount = Math.ceil(video.duration_seconds / intervalSeconds);
    
    // Calculate grid dimensions (prefer wider grids)
    const cols = Math.ceil(Math.sqrt(tileCount * 2)); // Favor more columns
    const rows = Math.ceil(tileCount / cols);

    // Generate unique filenames
    const timestamp = Date.now();
    const spriteFilename = `storyboard_${videoId}_${timestamp}.jpg`;
    const vttFilename = `storyboard_${videoId}_${timestamp}.vtt`;
    const spritePath = join(env.STORYBOARDS_DIR, spriteFilename);
    const vttPath = join(env.STORYBOARDS_DIR, vttFilename);

    const options: SpriteSheetOptions = {
      inputPath: video.file_path,
      outputPath: spritePath,
      tileWidth,
      tileHeight,
      intervalSeconds,
      cols,
      rows,
      videoFps: video.fps ?? 30,
    };

    // Generate sprite sheet using FFmpeg
    await this.generateSpriteSheet(options);

    // Get sprite file size
    const stats = await stat(spritePath);
    const spriteSizeBytes = stats.size;

    // Generate VTT file
    this.generateVttFile(
      vttPath,
      videoId,
      tileWidth,
      tileHeight,
      intervalSeconds,
      tileCount,
      cols,
      video.duration_seconds
    );

    // Insert into database
    const result = this.db
      .prepare(
        `INSERT INTO storyboards (
          video_id, sprite_path, vtt_path, tile_width, tile_height, 
          tile_count, interval_seconds, sprite_size_bytes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        videoId,
        spritePath,
        vttPath,
        tileWidth,
        tileHeight,
        tileCount,
        intervalSeconds,
        spriteSizeBytes
      );

    return this.findById(result.lastInsertRowid as number);
  }

  /**
   * Generate sprite sheet image using FFmpeg.
   */
private async generateSpriteSheet(options: SpriteSheetOptions): Promise<void> {
  const { inputPath } = options;
  
  const fileSize = (await stat(inputPath)).size;
  const availableShm = await this.getAvailableShm();
  const availableRam = await this.getAvailableMemory(); // Use new method
  
  const shmUsable = availableShm * 0.8;
  const ramBuffer = 2 * 1024 * 1024 * 1024;
  
  const canUseRam = fileSize < shmUsable && fileSize < (availableRam - ramBuffer);
  
  console.log('Can use RAM:', canUseRam, {
    fileSize: this.formatBytes(fileSize),
    shmUsable: this.formatBytes(shmUsable),
    availableRam: this.formatBytes(availableRam),
    ramBuffer: this.formatBytes(ramBuffer),
    needed: this.formatBytes(fileSize),
    actuallyAvailable: this.formatBytes(availableRam - ramBuffer),
  });
  
  if (canUseRam) {
    await this.processFromRam(options);
  } else {
    await this.processSequential(options);
  }
}

private formatBytes(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  return `${gb.toFixed(2)}GB`;
}

private async getAvailableShm(): Promise<number> {
  try {
    const { execSync } = await import('child_process');
    const output = execSync("df -B1 /dev/shm | tail -1 | awk '{print $4}'").toString().trim();
    return parseInt(output, 10);
  } catch {
    return 0;
  }
}

private async getAvailableMemory(): Promise<number> {
  try {
    const meminfo = await readFile('/proc/meminfo', 'utf-8');
    const match = meminfo.match(/MemAvailable:\s+(\d+)\s+kB/);
    if (match) {
      return parseInt(match[1], 10) * 1024; // Convert KB to bytes
    }
  } catch {
    // Fallback for non-Linux systems
  }
  
  // Fallback to freemem (less accurate)
  return freemem();
}

private async processFromRam(options: SpriteSheetOptions): Promise<void> {
  const { inputPath, outputPath, tileWidth, tileHeight, intervalSeconds, cols, rows } = options;
  const ramPath = `/dev/shm/sprite_temp_${Date.now()}${this.getExtension(inputPath)}`;
  
  try {
    await copyFile(inputPath, ramPath);
    
    await new Promise<void>((resolve, reject) => {
      ffmpeg(ramPath)
        .inputOptions([
          `-hwaccel`, `vaapi`,
          `-hwaccel_device`, `/dev/dri/renderD128`,
          // Remove hwaccel_output_format - let frames auto-transfer to CPU after decode
        ])
        .outputOptions([
          `-vf`, `fps=1/${intervalSeconds},scale=${tileWidth}:${tileHeight},tile=${cols}x${rows}`,
          `-frames:v`, `1`,
          `-q:v`, `5`,
        ])
        .output(outputPath)
        .on('end', () => resolve())
        .on('error', (err) => reject(err))
        .run();
    });
  } finally {
    await unlink(ramPath).catch(() => {});
  }
}

private async processSequential(options: SpriteSheetOptions): Promise<void> {
  const { inputPath, outputPath, tileWidth, tileHeight, intervalSeconds, cols, rows, videoFps } = options;
  
  // Need FPS to calculate frame selection interval
  const fps = videoFps ?? 30;
  const selectInterval = Math.round(fps * intervalSeconds);
  console.log('Processing sequentially:', inputPath, outputPath, selectInterval);
  
  await new Promise<void>((resolve, reject) => {
    ffmpeg(inputPath)
      .inputOptions([
        `-hwaccel`, `vaapi`,
        `-hwaccel_device`, `/dev/dri/renderD128`,
        `-hwaccel_output_format`, `vaapi`,
      ])
      .outputOptions([
        `-vf`, `select='not(mod(n\\,${selectInterval}))',scale_vaapi=${tileWidth}:${tileHeight},hwdownload,format=nv12,tile=${cols}x${rows}`,
        `-vsync`, `vfr`,
        `-frames:v`, `1`,
        `-q:v`, `5`,
      ])
      .output(outputPath)
      .on('end', () => resolve())
      .on('error', (err) => reject(err))
      .run();
  });
}

  /**
   * Generate WebVTT file with sprite coordinates.
   */
  private generateVttFile(
    vttPath: string,
    videoId: number,
    tileWidth: number,
    tileHeight: number,
    intervalSeconds: number,
    tileCount: number,
    cols: number,
    duration: number
  ): void {
    let vttContent = 'WEBVTT\n\n';

    for (let i = 0; i < tileCount; i++) {
      const startTime = i * intervalSeconds;
      const endTime = Math.min((i + 1) * intervalSeconds, duration);

      // Calculate tile position in sprite
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = col * tileWidth;
      const y = row * tileHeight;

      // Format timestamps as HH:MM:SS.mmm
      const startFormatted = this.formatVttTime(startTime);
      const endFormatted = this.formatVttTime(endTime);

      // Use relative URL for the sprite (same endpoint path)
      vttContent += `${startFormatted} --> ${endFormatted}\n`;
      vttContent += `/api/videos/${videoId}/storyboard.jpg#xywh=${x},${y},${tileWidth},${tileHeight}\n\n`;
    }

    writeFileSync(vttPath, vttContent, 'utf-8');
  }

  /**
   * Format seconds to VTT timestamp format (HH:MM:SS.mmm).
   */
  private formatVttTime(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const millis = Math.round((seconds % 1) * 1000);

    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${millis.toString().padStart(3, '0')}`;
  }

  /**
   * Find storyboard by ID.
   */
  async findById(id: number): Promise<Storyboard> {
    const storyboard = this.db
      .prepare('SELECT * FROM storyboards WHERE id = ?')
      .get(id) as Storyboard | undefined;

    if (!storyboard) {
      throw new NotFoundError(`Storyboard not found with id: ${id}`);
    }

    return storyboard;
  }

  /**
   * Find storyboard by video ID.
   */
  async findByVideoId(videoId: number): Promise<Storyboard | null> {
    const storyboard = this.db
      .prepare('SELECT * FROM storyboards WHERE video_id = ?')
      .get(videoId) as Storyboard | undefined;

    return storyboard ?? null;
  }

  /**
   * Get VTT file content for a video.
   */
  async getVttContent(videoId: number): Promise<string> {
    const storyboard = await this.findByVideoId(videoId);

    if (!storyboard) {
      throw new NotFoundError(`Storyboard not found for video: ${videoId}`);
    }

    if (!existsSync(storyboard.vtt_path)) {
      throw new NotFoundError(`VTT file not found: ${storyboard.vtt_path}`);
    }

    return readFileSync(storyboard.vtt_path, 'utf-8');
  }

  /**
   * Get sprite image buffer for a video.
   */
  async getSpriteBuffer(videoId: number): Promise<Buffer> {
    const storyboard = await this.findByVideoId(videoId);

    if (!storyboard) {
      throw new NotFoundError(`Storyboard not found for video: ${videoId}`);
    }

    if (!existsSync(storyboard.sprite_path)) {
      throw new NotFoundError(`Sprite file not found: ${storyboard.sprite_path}`);
    }

    return readFileSync(storyboard.sprite_path);
  }

  /**
   * Delete storyboard for a video.
   */
  async delete(videoId: number): Promise<void> {
    const storyboard = await this.findByVideoId(videoId);

    if (!storyboard) {
      throw new NotFoundError(`Storyboard not found for video: ${videoId}`);
    }

    // Delete files
    try {
      if (existsSync(storyboard.sprite_path)) {
        unlinkSync(storyboard.sprite_path);
      }
      if (existsSync(storyboard.vtt_path)) {
        unlinkSync(storyboard.vtt_path);
      }
    } catch (error) {
      console.error(`Failed to delete storyboard files for video ${videoId}:`, error);
    }

    // Delete database record
    this.db.prepare('DELETE FROM storyboards WHERE video_id = ?').run(videoId);
  }

  private getExtension(filePath: string): string {
    const match = filePath.match(/\.[^.]+$/);
    return match ? match[0] : '.mp4';
  }
}

export const storyboardsService = new StoryboardsService();
