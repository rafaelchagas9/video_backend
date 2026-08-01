import { join } from "path";
import { createReadStream, existsSync, mkdirSync } from "fs";
import ffmpeg from "fluent-ffmpeg";
import { db } from "@/config/drizzle";
import { storyboardsTable } from "@/database/schema";
import { eq } from "drizzle-orm";
import { env } from "@/config/env";
import { NotFoundError, InternalServerError } from "@/utils/errors";
import { videosService } from "@/modules/videos/videos.service";
import { eventsService } from "@/modules/events/events.service";
import { createVideoEventContext } from "@/modules/events/events.types";
import { logger } from "@/utils/logger";
import { recordPerfStage } from "@/utils/performance-profiler";
import type { Storyboard, GenerateStoryboardInput } from "./storyboards.types";
import { copyFile, unlink, stat, readFile, writeFile } from "fs/promises";
import { freemem } from "os";
import type { ExtractedFrame } from "@/modules/frame-extraction";
import { demoMediaAssetsService } from "@/modules/media/demo-media-assets.service";
import { resolveDemoAssetPath } from "@/database/demo";

interface SpriteSheetOptions {
  videoId: number;
  inputPath: string;
  outputPath: string;
  tileWidth: number;
  tileHeight: number;
  intervalSeconds: number;
  cols: number;
  rows: number;
  format: "webp" | "jpg";
  quality: number;
}

export class StoryboardsService {
  // Queue system for sequential processing
  private processingVideoId: number | null = null;
  private pendingQueue: number[] = [];
  private isProcessing = false;

  constructor() {
    // Ensure storyboards directory exists
    if (!env.DEMO_MODE && !existsSync(env.STORYBOARDS_DIR)) {
      mkdirSync(env.STORYBOARDS_DIR, { recursive: true });
    }
  }

  /**
   * Map Drizzle result (camelCase) to API format (snake_case)
   */
  private mapToApiFormat(
    row: typeof storyboardsTable.$inferSelect
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
    if (env.DEMO_MODE) {
      demoMediaAssetsService.generateStoryboard(videoId);
      return;
    }

    // Skip if this video is currently being processed
    if (this.processingVideoId === videoId) {
      logger.debug(
        { videoId },
        "Storyboard generation already in progress, skipping"
      );
      return;
    }

    // Skip if already in queue
    if (this.pendingQueue.includes(videoId)) {
      logger.debug(
        { videoId },
        "Storyboard generation already queued, skipping"
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
      "Storyboard generation queued"
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
          const video = await videosService.findById(videoId);
          const videoContext = createVideoEventContext(video);

          logger.info(
            { videoId, remaining: this.pendingQueue.length },
            "Processing storyboard generation"
          );

          eventsService.broadcastToAuthenticated({
            type: "storyboard:generating",
            message: {
              ...videoContext,
              message: "Generating storyboard thumbnails...",
              text: "Generating storyboard thumbnails...",
            },
          });

          await this.generate(videoId);

          eventsService.broadcastToAuthenticated({
            type: "storyboard:ready",
            message: {
              ...videoContext,
              message: "Storyboard thumbnails ready",
              text: "Storyboard thumbnails ready",
            },
          });
        }
      } catch (error) {
        logger.error({ videoId, error }, "Failed to generate storyboard");

        let videoContext = { videoId, video_id: videoId };
        try {
          videoContext = createVideoEventContext(
            await videosService.findById(videoId)
          );
        } catch {
          // Keep the failure event actionable even if video enrichment fails.
        }

        eventsService.broadcastToAuthenticated({
          type: "storyboard:error",
          message: {
            ...videoContext,
            message: "Failed to generate storyboard",
            text: "Failed to generate storyboard",
            error: error instanceof Error ? error.message : String(error),
          },
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
    input?: GenerateStoryboardInput
  ): Promise<Storyboard> {
    if (env.DEMO_MODE)
      return demoMediaAssetsService.generateStoryboard(videoId, input);
    const totalStart = Date.now();
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

    const { tileWidth, tileHeight } = this.getTileDimensions(
      video.width,
      video.height,
      input?.tileWidth,
      input?.tileHeight
    );
    const requestedIntervalSeconds =
      input?.intervalSeconds ?? env.STORYBOARD_INTERVAL_SECONDS;
    const storyboardFormat = env.STORYBOARD_FORMAT;
    const storyboardQuality = env.STORYBOARD_QUALITY;

    if (!video.duration_seconds || video.duration_seconds <= 0) {
      throw new InternalServerError(
        "Video duration not available for storyboard generation"
      );
    }

    const intervalSeconds = this.getEffectiveIntervalSeconds(
      video.duration_seconds,
      requestedIntervalSeconds
    );

    if (intervalSeconds !== requestedIntervalSeconds) {
      logger.info(
        {
          videoId,
          requestedIntervalSeconds,
          effectiveIntervalSeconds: intervalSeconds,
          durationSeconds: video.duration_seconds,
          maxTiles: env.STORYBOARD_MAX_TILES,
        },
        "Adjusted storyboard interval for long video"
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
      videoId,
      inputPath: video.file_path,
      outputPath: spritePath,
      tileWidth,
      tileHeight,
      intervalSeconds,
      cols,
      rows,
      format: storyboardFormat,
      quality: storyboardQuality,
    };

    // Generate sprite sheet using FFmpeg
    const spriteStart = Date.now();
    await this.generateSpriteSheet(options);
    await recordPerfStage(
      { scenario: "storyboard", videoId, mode: "generate" },
      "sprite_sheet",
      Date.now() - spriteStart,
      {
        tileCount,
        intervalSeconds,
        requestedIntervalSeconds,
        cols,
        rows,
      }
    );

    // Get sprite file size
    const stats = await stat(spritePath);
    const spriteSizeBytes = stats.size;

    // Generate VTT file
    const vttStart = Date.now();
    await this.generateVttFile(
      vttPath,
      videoId,
      tileWidth,
      tileHeight,
      intervalSeconds,
      tileCount,
      cols,
      video.duration_seconds,
      storyboardFormat
    );
    await recordPerfStage(
      { scenario: "storyboard", videoId, mode: "generate" },
      "vtt_file",
      Date.now() - vttStart,
      { tileCount, intervalSeconds, cols }
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

    await recordPerfStage(
      { scenario: "storyboard", videoId, mode: "generate" },
      "total",
      Date.now() - totalStart,
      { tileCount, spriteSizeBytes }
    );

    return this.mapToApiFormat(result[0]);
  }

  /**
   * Assemble a storyboard sprite sheet from pre-extracted frames
   * Used by unified frame extraction workflow
   */
  async assembleFromFrames(
    videoId: number,
    frames: ExtractedFrame[],
    videoDuration: number
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

    const video = await videosService.findById(videoId);
    const { tileWidth, tileHeight } = this.getTileDimensions(
      video.width,
      video.height,
      env.STORYBOARD_TILE_WIDTH,
      env.STORYBOARD_TILE_HEIGHT
    );
    const storyboardFormat = env.STORYBOARD_FORMAT;
    const storyboardQuality = env.STORYBOARD_QUALITY;
    const tileCount = frames.length;

    if (tileCount === 0) {
      throw new InternalServerError(
        "No frames provided for storyboard assembly"
      );
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
    await this.generateVttFile(
      vttPath,
      videoId,
      tileWidth,
      tileHeight,
      intervalSeconds,
      tileCount,
      cols,
      videoDuration,
      storyboardFormat
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
    }
  ): Promise<void> {
    const { cols, rows, tileWidth, tileHeight, format, quality } = options;

    // Create input file list for FFmpeg concat demuxer
    const inputListPath = `${outputPath}.txt`;
    const inputListContent = frames
      .map((frame) => `file '${frame.filePath}'`)
      .join("\n");
    await writeFile(inputListPath, inputListContent, "utf-8");

    const qualityOptions = this.getQualityOptions(format, quality);

    try {
      await new Promise<void>((resolve, reject) => {
        ffmpeg()
          .input(inputListPath)
          .inputOptions(["-f", "concat", "-safe", "0"])
          .outputOptions([
            "-vf",
            `${this.getScaleFilter(tileWidth, tileHeight)},tile=${cols}x${rows}`,
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
            logger.error(
              { error: err, outputPath },
              "Failed to assemble sprite sheet"
            );
            reject(err);
          })
          .run();
      });
    } finally {
      // Clean up input list file
      try {
        await unlink(inputListPath);
      } catch (error) {
        logger.warn(
          { path: inputListPath },
          "Failed to clean up input list file"
        );
      }
    }
  }

  /**
   * Generate sprite sheet image using FFmpeg.
   */
  private async generateSpriteSheet(
    options: SpriteSheetOptions
  ): Promise<void> {
    const { inputPath, videoId } = options;
    const decisionStart = Date.now();

    const fileSize = (await stat(inputPath)).size;
    const availableShm = await this.getAvailableShm();
    const availableRam = await this.getAvailableMemory(); // Use new method

    const shmUsable = availableShm * 0.8;
    const ramBuffer = 2 * 1024 * 1024 * 1024;

    // Copying very large files to /dev/shm can dominate total time.
    // Keep RAM-copy path only for relatively small inputs.
    const maxRamCopyBytes = env.STORYBOARD_RAM_COPY_MAX_MB * 1024 * 1024;
    const canUseRam =
      fileSize < maxRamCopyBytes &&
      fileSize < shmUsable &&
      fileSize < availableRam - ramBuffer;

    logger.debug(
      {
        canUseRam,
        fileSize: this.formatBytes(fileSize),
        shmUsable: this.formatBytes(shmUsable),
        availableRam: this.formatBytes(availableRam),
        ramBuffer: this.formatBytes(ramBuffer),
        needed: this.formatBytes(fileSize),
        actuallyAvailable: this.formatBytes(availableRam - ramBuffer),
        maxRamCopyBytes: this.formatBytes(maxRamCopyBytes),
      },
      "Storyboard RAM path decision"
    );

    await recordPerfStage(
      { scenario: "storyboard", videoId, mode: "sprite_sheet" },
      "path_decision",
      Date.now() - decisionStart,
      {
        canUseRam,
        fileSizeBytes: fileSize,
        maxRamCopyBytes,
      }
    );

    if (canUseRam) {
      const ramStart = Date.now();
      await this.processFromRam(options);
      await recordPerfStage(
        { scenario: "storyboard", videoId, mode: "sprite_sheet" },
        "process_from_ram",
        Date.now() - ramStart,
        { fileSizeBytes: fileSize }
      );
    } else {
      const seqStart = Date.now();
      await this.processSequential(options);
      await recordPerfStage(
        { scenario: "storyboard", videoId, mode: "sprite_sheet" },
        "process_sequential",
        Date.now() - seqStart,
        { fileSizeBytes: fileSize }
      );
    }
  }

  private formatBytes(bytes: number): string {
    const gb = bytes / (1024 * 1024 * 1024);
    return `${gb.toFixed(2)}GB`;
  }

  private async getAvailableShm(): Promise<number> {
    try {
      const { exec } = await import("child_process");
      const { promisify } = await import("util");
      const execAsync = promisify(exec);
      const { stdout } = await execAsync(
        "df -B1 /dev/shm | tail -1 | awk '{print $4}'"
      );
      return parseInt(stdout.trim(), 10);
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
    quality: number
  ): string[] {
    if (format === "webp") {
      return ["-q:v", quality.toString()];
    }

    const jpegQuality = Math.round(2 + ((100 - quality) / 100) * 29);
    return ["-qscale:v", jpegQuality.toString()];
  }

  private getScaleFilter(tileWidth: number, tileHeight: number): string {
    return `scale=w=${tileWidth}:h=${tileHeight}:force_original_aspect_ratio=decrease,pad=${tileWidth}:${tileHeight}:(ow-iw)/2:(oh-ih)/2`;
  }

  private getTileDimensions(
    width: number | null | undefined,
    height: number | null | undefined,
    overrideWidth?: number,
    overrideHeight?: number
  ): { tileWidth: number; tileHeight: number } {
    const baseWidth = overrideWidth ?? env.STORYBOARD_TILE_WIDTH;
    const baseHeight = overrideHeight ?? env.STORYBOARD_TILE_HEIGHT;

    if (!width || !height) {
      return { tileWidth: baseWidth, tileHeight: baseHeight };
    }

    if (height > width) {
      return { tileWidth: baseHeight, tileHeight: baseWidth };
    }

    return { tileWidth: baseWidth, tileHeight: baseHeight };
  }

  private getEffectiveIntervalSeconds(
    durationSeconds: number,
    requestedIntervalSeconds: number
  ): number {
    const maxTiles = Math.max(1, env.STORYBOARD_MAX_TILES);
    const intervalByTileLimit = Math.ceil(durationSeconds / maxTiles);
    return Math.max(1, requestedIntervalSeconds, intervalByTileLimit);
  }

  private async processFromRam(options: SpriteSheetOptions): Promise<void> {
    const {
      videoId,
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
      const copyStart = Date.now();
      await copyFile(inputPath, ramPath);
      await recordPerfStage(
        { scenario: "storyboard", videoId, mode: "process_from_ram" },
        "copy_to_ram",
        Date.now() - copyStart
      );

      const ffmpegStart = Date.now();
      await new Promise<void>((resolve, reject) => {
        ffmpeg(ramPath)
          .inputOptions([
            `-hwaccel`,
            `vaapi`,
            `-hwaccel_device`,
            env.VAAPI_DEVICE,
            `-hwaccel_output_format`,
            `vaapi`,
          ])
          .outputOptions([
            `-vf`,
            `fps=1/${intervalSeconds},scale_vaapi=w=${tileWidth}:h=${tileHeight}:force_original_aspect_ratio=decrease,hwdownload,format=nv12,pad=${tileWidth}:${tileHeight}:(ow-iw)/2:(oh-ih)/2,tile=${cols}x${rows}`,
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
      await recordPerfStage(
        { scenario: "storyboard", videoId, mode: "process_from_ram" },
        "ffmpeg_from_ram",
        Date.now() - ffmpegStart
      );
    } finally {
      await unlink(ramPath).catch(() => {});
    }
  }

  private async processSequential(options: SpriteSheetOptions): Promise<void> {
    const {
      videoId,
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

    const qualityOptions = this.getQualityOptions(format, quality);
    logger.debug(
      { inputPath, outputPath, intervalSeconds },
      "Processing storyboard sequentially (HDD path)"
    );

    const fileSizeBytes = (await stat(inputPath)).size;
    const readaheadMaxBytes = env.STORYBOARD_READAHEAD_MAX_MB * 1024 * 1024;

    if (fileSizeBytes <= readaheadMaxBytes) {
      // Prime page cache only for smaller files; for very large files this can
      // double total read volume and hurt end-to-end completion time.
      const readAheadStart = Date.now();
      await this.primePageCache(inputPath);
      await recordPerfStage(
        { scenario: "storyboard", videoId, mode: "process_sequential" },
        "prime_page_cache",
        Date.now() - readAheadStart,
        { fileSizeBytes, readaheadMaxBytes }
      );
    } else {
      await recordPerfStage(
        { scenario: "storyboard", videoId, mode: "process_sequential" },
        "prime_page_cache_skipped",
        0,
        { fileSizeBytes, readaheadMaxBytes }
      );
    }

    const ffmpegStart = Date.now();
    await new Promise<void>((resolve, reject) => {
      ffmpeg(inputPath)
        .inputOptions([
          `-hwaccel`,
          `vaapi`,
          `-hwaccel_device`,
          env.VAAPI_DEVICE,
          `-hwaccel_output_format`,
          `vaapi`,
        ])
        .outputOptions([
          `-vf`,
          `fps=1/${intervalSeconds},scale_vaapi=w=${tileWidth}:h=${tileHeight}:force_original_aspect_ratio=decrease,hwdownload,format=nv12,pad=${tileWidth}:${tileHeight}:(ow-iw)/2:(oh-ih)/2,tile=${cols}x${rows}`,
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
    await recordPerfStage(
      { scenario: "storyboard", videoId, mode: "process_sequential" },
      "ffmpeg_sequential",
      Date.now() - ffmpegStart
    );
  }

  /**
   * Generate WebVTT file with sprite coordinates.
   */
  private async generateVttFile(
    vttPath: string,
    videoId: number,
    tileWidth: number,
    tileHeight: number,
    intervalSeconds: number,
    tileCount: number,
    cols: number,
    duration: number,
    spriteFormat: string
  ): Promise<void> {
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

    await writeFile(vttPath, vttContent, "utf-8");
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
    if (env.DEMO_MODE) return demoMediaAssetsService.storyboard(id);
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
    if (env.DEMO_MODE) {
      try {
        return demoMediaAssetsService.storyboard(videoId);
      } catch (error) {
        if (error instanceof NotFoundError) return null;
        throw error;
      }
    }
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
    if (env.DEMO_MODE) {
      const storyboard = demoMediaAssetsService.storyboard(videoId);
      return readFile(
        resolveDemoAssetPath(storyboard.vtt_path, { mustExist: true }),
        "utf-8"
      );
    }
    const storyboard = await this.findByVideoId(videoId);

    if (!storyboard) {
      throw new NotFoundError(`Storyboard not found for video: ${videoId}`);
    }

    if (!existsSync(storyboard.vtt_path)) {
      throw new NotFoundError(`VTT file not found: ${storyboard.vtt_path}`);
    }

    return readFile(storyboard.vtt_path, "utf-8");
  }

  /**
   * Get sprite image buffer and content type for a video.
   */
  async getSpriteAsset(
    videoId: number
  ): Promise<{ buffer: Buffer; contentType: string }> {
    if (env.DEMO_MODE) {
      const storyboard = demoMediaAssetsService.storyboard(videoId);
      const spritePath = resolveDemoAssetPath(storyboard.sprite_path, {
        mustExist: true,
      });
      const extension = spritePath.split(".").pop()?.toLowerCase();
      return {
        buffer: await readFile(spritePath),
        contentType:
          extension === "png"
            ? "image/png"
            : extension === "webp"
              ? "image/webp"
              : "image/jpeg",
      };
    }
    const storyboard = await this.findByVideoId(videoId);

    if (!storyboard) {
      throw new NotFoundError(`Storyboard not found for video: ${videoId}`);
    }

    if (!existsSync(storyboard.sprite_path)) {
      throw new NotFoundError(
        `Sprite file not found: ${storyboard.sprite_path}`
      );
    }

    const extension = this.getExtension(storyboard.sprite_path).toLowerCase();
    const contentType = extension === ".webp" ? "image/webp" : "image/jpeg";

    return { buffer: await readFile(storyboard.sprite_path), contentType };
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
    if (env.DEMO_MODE) {
      demoMediaAssetsService.deleteStoryboard(videoId);
      return;
    }
    const storyboard = await this.findByVideoId(videoId);

    if (!storyboard) {
      throw new NotFoundError(`Storyboard not found for video: ${videoId}`);
    }

    // Delete files
    try {
      await Promise.all([
        existsSync(storyboard.sprite_path)
          ? unlink(storyboard.sprite_path)
          : Promise.resolve(),
        existsSync(storyboard.vtt_path)
          ? unlink(storyboard.vtt_path)
          : Promise.resolve(),
      ]);
    } catch (error) {
      logger.error(
        { videoId, error },
        `Failed to delete storyboard files for video ${videoId}`
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

  /**
   * Prime the OS page cache by reading the file sequentially.
   * This converts slow random HDD I/O into sequential reads so FFmpeg
   * finds the data in cache rather than stalling on disk seeks.
   */
  private primePageCache(filePath: string): Promise<void> {
    return new Promise((resolve) => {
      // 16 MB chunks — keeps the read sequential, matches HDD optimal block size
      const stream = createReadStream(filePath, {
        highWaterMark: 16 * 1024 * 1024,
      });
      // Discard data; we only want the side-effect of filling the page cache
      stream.on("data", () => {});
      stream.on("end", () => resolve());
      // On error we still proceed — worst case FFmpeg reads from disk directly
      stream.on("error", (err) => {
        logger.warn({ filePath, err }, "Page cache priming failed, continuing");
        resolve();
      });
    });
  }
}

export const storyboardsService = new StoryboardsService();
