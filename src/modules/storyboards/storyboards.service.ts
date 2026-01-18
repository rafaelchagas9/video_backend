import { join } from "path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import ffmpeg from "fluent-ffmpeg";
import { db } from "@/config/drizzle";
import { storyboardsTable } from "@/database/schema";
import { eq } from "drizzle-orm";
import { env } from "@/config/env";
import { NotFoundError, InternalServerError } from "@/utils/errors";
import { videosService } from "@/modules/videos/videos.service";
import { logger } from "@/utils/logger";
import type { Storyboard, GenerateStoryboardInput } from "./storyboards.types";
import { copyFile, unlink, stat, readFile } from "fs/promises";
import { freemem } from "os";
import type { ExtractedFrame } from "@/modules/frame-extraction";

interface SpriteSheetOptions {
  inputPath: string;
  outputPath: string;
  tileWidth: number;
  tileHeight: number;
  intervalSeconds: number;
  cols: number;
  rows: number;
  format: "webp" | "jpg";
  quality: number;
  videoFps?: number; // Needed for select filter fallback
}

export class StoryboardsService {
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
   * Map Drizzle result (camelCase) to API format (snake_case)
   */
  private mapToApiFormat(
    row: typeof storyboardsTable.$inferSelect,
  ): Storyboard {
    return {
      id: row.id,
      video_id: row.videoId,
      sprite_path: row.spritePath,
      vtt_path: row.vttPath,
      tile_width: row.tileWidth,
      tile_height: row.tileHeight,
      tile_count: row.tileCount,
      interval_seconds: row.intervalSeconds,
      sprite_size_bytes: row.spriteSizeBytes,
      generated_at:
        row.generatedAt instanceof Date
          ? row.generatedAt.toISOString()
          : row.generatedAt,
    };
  }

  /**
   * Queue a storyboard generation job.
   * - If already processing this video, skip.
   * - If already in queue, skip.
   * - Otherwise add to queue and start processing if not already running.
   */
  async queueGenerate(videoId: number): Promise<void> {
    // Skip if this video is currently being processed
    if (this.processingVideoId === videoId) {
      logger.debug(
        { videoId },
        "Storyboard generation already in progress, skipping",
      );
      return;
    }

    // Skip if already in queue
    if (this.pendingQueue.includes(videoId)) {
      logger.debug(
        { videoId },
        "Storyboard generation already queued, skipping",
      );
      return;
    }

    // Check if storyboard already exists
    const existing = await this.findByVideoId(videoId);
    if (existing) {
      logger.debug({ videoId }, "Storyboard already exists, skipping");
      return;
    }

    // Add to queue
    this.pendingQueue.push(videoId);
    logger.info(
      { videoId, queueLength: this.pendingQueue.length },
      "Storyboard generation queued",
    );

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
          logger.info(
            { videoId, remaining: this.pendingQueue.length },
            "Processing storyboard generation",
          );

          // Import websocket service for notifications
          const { websocketService } =
            await import("@/modules/websocket/websocket");

          websocketService.broadcastToAuthenticated({
            type: "storyboard:generating",
            message: { videoId, text: "Generating storyboard thumbnails..." },
            timestamp: new Date().toISOString(),
          });

          await this.generate(videoId);

          websocketService.broadcastToAuthenticated({
            type: "storyboard:ready",
            message: { videoId, text: "Storyboard thumbnails ready" },
            timestamp: new Date().toISOString(),
          });
        }
      } catch (error) {
        logger.error({ videoId, error }, "Failed to generate storyboard");

        const { websocketService } =
          await import("@/modules/websocket/websocket");
        websocketService.broadcastToAuthenticated({
          type: "storyboard:error",
          message: {
            videoId,
            text: "Failed to generate storyboard",
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
  async generate(
    videoId: number,
    input?: GenerateStoryboardInput,
  ): Promise<Storyboard> {
    const video = await videosService.findById(videoId);

    // Delete existing storyboard if present
    const existing = await db
      .select()
      .from(storyboardsTable)
      .where(eq(storyboardsTable.videoId, videoId))
      .limit(1);

    if (existing.length > 0) {
      await this.delete(videoId);
    }

    // Use input overrides or env defaults
    const tileWidth = input?.tileWidth ?? env.STORYBOARD_TILE_WIDTH;
    const tileHeight = input?.tileHeight ?? env.STORYBOARD_TILE_HEIGHT;
    const intervalSeconds =
      input?.intervalSeconds ?? env.STORYBOARD_INTERVAL_SECONDS;
    const storyboardFormat = env.STORYBOARD_FORMAT;
    const storyboardQuality = env.STORYBOARD_QUALITY;

    if (!video.duration_seconds || video.duration_seconds <= 0) {
      throw new InternalServerError(
        "Video duration not available for storyboard generation",
      );
    }

    // Calculate number of tiles needed
    const tileCount = Math.ceil(video.duration_seconds / intervalSeconds);

    // Calculate grid dimensions (prefer wider grids)
    const cols = Math.ceil(Math.sqrt(tileCount * 2)); // Favor more columns
    const rows = Math.ceil(tileCount / cols);

    // Generate unique filenames
    const timestamp = Date.now();
    const spriteFilename = `storyboard_${videoId}_${timestamp}.${storyboardFormat}`;
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
      format: storyboardFormat,
      quality: storyboardQuality,
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
      video.duration_seconds,
      storyboardFormat,
    );

    // Insert into database
    const result = await db
      .insert(storyboardsTable)
      .values({
        videoId,
        spritePath,
        vttPath,
        tileWidth,
        tileHeight,
        tileCount,
        intervalSeconds,
        spriteSizeBytes,
      })
      .returning();

    return this.mapToApiFormat(result[0]);
  }

  /**
   * Assemble a storyboard sprite sheet from pre-extracted frames
   * Used by unified frame extraction workflow
   */
  async assembleFromFrames(
    videoId: number,
    frames: ExtractedFrame[],
    videoDuration: number,
  ): Promise<Storyboard> {
    // Delete existing storyboard if present
    const existing = await db
      .select()
      .from(storyboardsTable)
      .where(eq(storyboardsTable.videoId, videoId))
      .limit(1);

    if (existing.length > 0) {
      await this.delete(videoId);
    }

    const tileWidth = env.STORYBOARD_TILE_WIDTH;
    const tileHeight = env.STORYBOARD_TILE_HEIGHT;
    const storyboardFormat = env.STORYBOARD_FORMAT;
    const storyboardQuality = env.STORYBOARD_QUALITY;
    const tileCount = frames.length;

    if (tileCount === 0) {
      throw new InternalServerError("No frames provided for storyboard assembly");
    }

    // Calculate interval from frames
    const intervalSeconds =
      frames.length > 1
        ? frames[1].timestampSeconds - frames[0].timestampSeconds
        : 10; // fallback

    // Calculate grid dimensions (prefer wider grids)
    const cols = Math.ceil(Math.sqrt(tileCount * 2));
    const rows = Math.ceil(tileCount / cols);

    // Generate unique filenames
    const timestamp = Date.now();
    const spriteFilename = `storyboard_${videoId}_${timestamp}.${storyboardFormat}`;
    const vttFilename = `storyboard_${videoId}_${timestamp}.vtt`;
    const spritePath = join(env.STORYBOARDS_DIR, spriteFilename);
    const vttPath = join(env.STORYBOARDS_DIR, vttFilename);

    // Assemble frames into sprite sheet using FFmpeg
    await this.assembleSprite(frames, spritePath, {
      cols,
      rows,
      tileWidth,
      tileHeight,
      format: storyboardFormat,
      quality: storyboardQuality,
    });

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
      videoDuration,
      storyboardFormat,
    );

    // Insert into database
    const result = await db
      .insert(storyboardsTable)
      .values({
        videoId,
        spritePath,
        vttPath,
        tileWidth,
        tileHeight,
        tileCount,
        intervalSeconds,
        spriteSizeBytes,
      })
      .returning();

    return this.mapToApiFormat(result[0]);
  }

  /**
   * Assemble individual frames into a sprite sheet using FFmpeg tile filter
   */
  private async assembleSprite(
    frames: ExtractedFrame[],
    outputPath: string,
    options: {
      cols: number;
      rows: number;
      tileWidth: number;
      tileHeight: number;
      format: "webp" | "jpg";
      quality: number;
    },
  ): Promise<void> {
    const { cols, rows, tileWidth, tileHeight, format, quality } = options;

    // Create input file list for FFmpeg concat demuxer
    const inputListPath = `${outputPath}.txt`;
    const inputListContent = frames
      .map((frame) => `file '${frame.filePath}'`)
      .join("\n");
    writeFileSync(inputListPath, inputListContent, "utf-8");

    const qualityOptions = this.getQualityOptions(format, quality);

    try {
      await new Promise<void>((resolve, reject) => {
        ffmpeg()
          .input(inputListPath)
          .inputOptions(["-f", "concat", "-safe", "0"])
          .outputOptions([
            "-vf",
            `scale=${tileWidth}:${tileHeight},tile=${cols}x${rows}`,
            "-frames:v",
            "1",
            "-an",
            "-sn",
            "-dn",
            ...qualityOptions,
          ])
          .output(outputPath)
          .on("end", () => {
            logger.debug({ outputPath }, "Sprite sheet assembled from frames");
            resolve();
          })
          .on("error", (err) => {
            logger.error({ error: err, outputPath }, "Failed to assemble sprite sheet");
            reject(err);
          })
          .run();
      });
    } finally {
      // Clean up input list file
      try {
        unlinkSync(inputListPath);
      } catch (error) {
        logger.warn({ path: inputListPath }, "Failed to clean up input list file");
      }
    }
  }

  /**
   * Generate sprite sheet image using FFmpeg.
   */
  private async generateSpriteSheet(
    options: SpriteSheetOptions,
  ): Promise<void> {
    const { inputPath } = options;

    const fileSize = (await stat(inputPath)).size;
    const availableShm = await this.getAvailableShm();
    const availableRam = await this.getAvailableMemory(); // Use new method

    const shmUsable = availableShm * 0.8;
    const ramBuffer = 2 * 1024 * 1024 * 1024;

    const canUseRam =
      fileSize < shmUsable && fileSize < availableRam - ramBuffer;

    console.log("Can use RAM:", canUseRam, {
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
      const { execSync } = await import("child_process");
      const output = execSync("df -B1 /dev/shm | tail -1 | awk '{print $4}'")
        .toString()
        .trim();
      return parseInt(output, 10);
    } catch {
      return 0;
    }
  }

  private async getAvailableMemory(): Promise<number> {
    try {
      const meminfo = await readFile("/proc/meminfo", "utf-8");
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

  private getQualityOptions(
    format: SpriteSheetOptions["format"],
    quality: number,
  ): string[] {
    if (format === "webp") {
      return ["-q:v", quality.toString()];
    }

    const jpegQuality = Math.round(2 + ((100 - quality) / 100) * 29);
    return ["-qscale:v", jpegQuality.toString()];
  }

  private async processFromRam(options: SpriteSheetOptions): Promise<void> {
    const {
      inputPath,
      outputPath,
      tileWidth,
      tileHeight,
      intervalSeconds,
      cols,
      rows,
      format,
      quality,
    } = options;
    const ramPath = `/dev/shm/sprite_temp_${Date.now()}${this.getExtension(inputPath)}`;
    const qualityOptions = this.getQualityOptions(format, quality);

    try {
      await copyFile(inputPath, ramPath);

      await new Promise<void>((resolve, reject) => {
        ffmpeg(ramPath)
          .inputOptions([
            `-hwaccel`,
            `vaapi`,
            `-hwaccel_device`,
            `/dev/dri/renderD128`,
            // Remove hwaccel_output_format - let frames auto-transfer to CPU after decode
          ])
          .outputOptions([
            `-vf`,
            `fps=1/${intervalSeconds},scale=${tileWidth}:${tileHeight},tile=${cols}x${rows}`,
            `-frames:v`,
            `1`,
            `-an`,
            `-sn`,
            `-dn`,
            ...qualityOptions,
          ])
          .output(outputPath)
          .on("end", () => resolve())
          .on("error", (err) => reject(err))
          .run();
      });
    } finally {
      await unlink(ramPath).catch(() => {});
    }
  }

  private async processSequential(options: SpriteSheetOptions): Promise<void> {
    const {
      inputPath,
      outputPath,
      tileWidth,
      tileHeight,
      intervalSeconds,
      cols,
      rows,
      format,
      quality,
      videoFps,
    } = options;

    // Need FPS to calculate frame selection interval
    const fps = videoFps ?? 30;
    const selectInterval = Math.round(fps * intervalSeconds);
    const qualityOptions = this.getQualityOptions(format, quality);
    console.log(
      "Processing sequentially:",
      inputPath,
      outputPath,
      selectInterval,
    );

    await new Promise<void>((resolve, reject) => {
      ffmpeg(inputPath)
        .inputOptions([
          `-hwaccel`,
          `vaapi`,
          `-hwaccel_device`,
          `/dev/dri/renderD128`,
          `-hwaccel_output_format`,
          `vaapi`,
        ])
        .outputOptions([
          `-vf`,
          `select='not(mod(n\\,${selectInterval}))',scale_vaapi=${tileWidth}:${tileHeight},hwdownload,format=nv12,tile=${cols}x${rows}`,
          `-vsync`,
          `vfr`,
          `-frames:v`,
          `1`,
          `-an`,
          `-sn`,
          `-dn`,
          ...qualityOptions,
        ])
        .output(outputPath)
        .on("end", () => resolve())
        .on("error", (err) => reject(err))
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
    duration: number,
    spriteFormat: string,
  ): void {
    let vttContent = "WEBVTT\n\n";
    const spriteExtension = spriteFormat.startsWith(".")
      ? spriteFormat.slice(1)
      : spriteFormat;

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
      vttContent += `/api/videos/${videoId}/storyboard.${spriteExtension}#xywh=${x},${y},${tileWidth},${tileHeight}\n\n`;
    }

    writeFileSync(vttPath, vttContent, "utf-8");
  }

  /**
   * Format seconds to VTT timestamp format (HH:MM:SS.mmm).
   */
  private formatVttTime(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const millis = Math.round((seconds % 1) * 1000);

    return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}.${millis.toString().padStart(3, "0")}`;
  }

  /**
   * Find storyboard by ID.
   */
  async findById(id: number): Promise<Storyboard> {
    const rows = await db
      .select()
      .from(storyboardsTable)
      .where(eq(storyboardsTable.id, id))
      .limit(1);

    if (!rows || rows.length === 0) {
      throw new NotFoundError(`Storyboard not found with id: ${id}`);
    }

    return this.mapToApiFormat(rows[0]);
  }

  /**
   * Find storyboard by video ID.
   */
  async findByVideoId(videoId: number): Promise<Storyboard | null> {
    const rows = await db
      .select()
      .from(storyboardsTable)
      .where(eq(storyboardsTable.videoId, videoId))
      .limit(1);

    return rows.length > 0 ? this.mapToApiFormat(rows[0]) : null;
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

    return readFileSync(storyboard.vtt_path, "utf-8");
  }

  /**
   * Get sprite image buffer and content type for a video.
   */
  async getSpriteAsset(
    videoId: number,
  ): Promise<{ buffer: Buffer; contentType: string }> {
    const storyboard = await this.findByVideoId(videoId);

    if (!storyboard) {
      throw new NotFoundError(`Storyboard not found for video: ${videoId}`);
    }

    if (!existsSync(storyboard.sprite_path)) {
      throw new NotFoundError(
        `Sprite file not found: ${storyboard.sprite_path}`,
      );
    }

    const extension = this.getExtension(storyboard.sprite_path).toLowerCase();
    const contentType = extension === ".webp" ? "image/webp" : "image/jpeg";

    return { buffer: readFileSync(storyboard.sprite_path), contentType };
  }

  /**
   * Get sprite image buffer for a video.
   */
  async getSpriteBuffer(videoId: number): Promise<Buffer> {
    const { buffer } = await this.getSpriteAsset(videoId);
    return buffer;
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
      console.error(
        `Failed to delete storyboard files for video ${videoId}:`,
        error,
      );
    }

    // Delete database record
    await db
      .delete(storyboardsTable)
      .where(eq(storyboardsTable.videoId, videoId));
  }

  private getExtension(filePath: string): string {
    const match = filePath.match(/\.[^.]+$/);
    return match ? match[0] : ".mp4";
  }
}

export const storyboardsService = new StoryboardsService();
