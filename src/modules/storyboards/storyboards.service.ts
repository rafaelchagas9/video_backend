import { join, dirname, resolve, basename } from "path";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "fs";
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
import type {
  Storyboard,
  GenerateStoryboardInput,
  StoryboardGenerationStatus,
} from "./storyboards.types";
import { unlink, stat, readFile, writeFile } from "fs/promises";
import type { ExtractedFrame } from "@/modules/frame-extraction";
import { demoMediaAssetsService } from "@/modules/media/demo-media-assets.service";
import { resolveDemoAssetPath } from "@/database/demo";
import { captureTelemetryException } from "@/utils/telemetry";

import {
  StoryboardRenderer,
  assembleFramePages,
  type StoryboardRenderOptions,
} from "./storyboards.ffmpeg";
import {
  buildPagedStoryboardVtt,
  isPagedSpritePath,
  storyboardAssetPaths,
  storyboardImagePaths,
  storyboardPagePaths,
} from "./storyboards.pages";

interface SpriteSheetOptions extends StoryboardRenderOptions {
  videoId: number;
}

export class StoryboardsService {
  private readonly processingVideoIds = new Set<number>();
  private readonly generating = new Map<number, Promise<Storyboard>>();
  private readonly renderer = new StoryboardRenderer({
    ffmpegPath: env.FFMPEG_PATH,
    vaapiDevice: env.VAAPI_DEVICE,
    maxKeyframeDriftSeconds: env.STORYBOARD_MAX_KEYFRAME_DRIFT_SECONDS,
  });
  private pendingQueue: number[] = [];
  private readonly queuedOptions = new Map<
    number,
    { input?: GenerateStoryboardInput; force: boolean }
  >();
  private readonly generationStates = new Map<
    number,
    StoryboardGenerationStatus
  >();

  private setGenerationStatus(
    videoId: number,
    status: StoryboardGenerationStatus["status"],
    error?: string
  ): void {
    this.generationStates.delete(videoId);
    this.generationStates.set(videoId, {
      video_id: videoId,
      status,
      updated_at: new Date().toISOString(),
      ...(error ? { error } : {}),
    });
    // Bound retained outcomes without dropping active work.
    for (const [id, state] of this.generationStates) {
      if (this.generationStates.size <= 1000) break;
      if (state.status === "ready" || state.status === "failed")
        this.generationStates.delete(id);
    }
  }

  async getGenerationStatus(
    videoId: number
  ): Promise<StoryboardGenerationStatus> {
    await videosService.findById(videoId);
    if (!env.DEMO_MODE) {
      const active = this.generationStates.get(videoId);
      if (active && active.status !== "ready") return active;
    }
    const storyboard = await this.findByVideoId(videoId);
    return {
      video_id: videoId,
      status: storyboard ? "ready" : "idle",
      updated_at: storyboard?.generated_at ?? null,
    };
  }

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
  async queueGenerate(
    videoId: number,
    input?: GenerateStoryboardInput,
    force = false
  ): Promise<void> {
    if (env.DEMO_MODE) {
      demoMediaAssetsService.generateStoryboard(videoId, input);
      return;
    }

    // Skip if this video is currently being processed
    if (this.processingVideoIds.has(videoId) || this.generating.has(videoId)) {
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
    if (existing && !force) {
      logger.debug({ videoId }, "Storyboard already exists, skipping");
      return;
    }

    await videosService.findById(videoId);

    // Recheck after the database read: simultaneous hover requests can race.
    if (
      this.processingVideoIds.has(videoId) ||
      this.generating.has(videoId) ||
      this.pendingQueue.includes(videoId)
    )
      return;
    this.pendingQueue.push(videoId);
    this.queuedOptions.set(videoId, { input, force });
    this.setGenerationStatus(videoId, "queued");
    logger.info(
      { videoId, queueLength: this.pendingQueue.length },
      "Storyboard generation queued"
    );

    this.processQueue();
  }

  /** Start bounded workers; the shared media scheduler reserves capacity for previews. */
  private processQueue(): void {
    while (
      this.pendingQueue.length > 0 &&
      this.processingVideoIds.size < env.STORYBOARD_MAX_CONCURRENT
    ) {
      const videoId = this.pendingQueue.shift()!;
      this.processingVideoIds.add(videoId);
      void this.processQueuedVideo(videoId);
    }
  }

  private async processQueuedVideo(videoId: number): Promise<void> {
    const options = this.queuedOptions.get(videoId);
    this.queuedOptions.delete(videoId);
    try {
      const existing = await this.findByVideoId(videoId);
      if (!existing || options?.force)
        await this.generate(videoId, options?.input);
      else this.setGenerationStatus(videoId, "ready");
    } catch (error) {
      // generate() reports render/publication failures; also cover preflight failures.
      if (this.generationStates.get(videoId)?.status !== "failed") {
        this.setGenerationStatus(
          videoId,
          "failed",
          "Could not start storyboard generation. Please try again."
        );
        logger.error(
          { videoId, error },
          "Failed to start storyboard generation"
        );
        captureTelemetryException(error, { source: "storyboard_job", videoId });
      }
    } finally {
      this.processingVideoIds.delete(videoId);
      this.processQueue();
    }
  }

  /**
   * Generate a storyboard sprite sheet and VTT file for a video.
   * Uses FFmpeg to extract frames at intervals and tile them into a single image.
   */
  generate(
    videoId: number,
    input?: GenerateStoryboardInput
  ): Promise<Storyboard> {
    const active = this.generating.get(videoId);
    if (active) {
      logger.info(
        { videoId },
        "Storyboard generation already in progress; joining existing job"
      );
      return active;
    }
    const pending = this.runGeneration(videoId, input).finally(() =>
      this.generating.delete(videoId)
    );
    this.generating.set(videoId, pending);
    return pending;
  }

  private async runGeneration(
    videoId: number,
    input?: GenerateStoryboardInput
  ): Promise<Storyboard> {
    this.setGenerationStatus(videoId, "processing");
    const started = Date.now();
    let videoContext = { videoId, video_id: videoId };
    try {
      videoContext = createVideoEventContext(
        await videosService.findById(videoId)
      );
      logger.info({ videoId }, "Storyboard generation started");
      eventsService.broadcastToAuthenticated({
        type: "storyboard:generating",
        message: {
          ...videoContext,
          message: "Generating storyboard thumbnails...",
          text: "Generating storyboard thumbnails...",
        },
      });
      const storyboard = await this.generateInternal(videoId, input);
      this.setGenerationStatus(videoId, "ready");
      logger.info(
        {
          videoId,
          durationMs: Date.now() - started,
          tileCount: storyboard.tile_count,
        },
        "Storyboard generation completed"
      );
      eventsService.broadcastToAuthenticated({
        type: "storyboard:ready",
        message: {
          ...videoContext,
          message: "Storyboard thumbnails ready",
          text: "Storyboard thumbnails ready",
        },
      });
      return storyboard;
    } catch (error) {
      const message = "Storyboard generation failed. Please try again.";
      this.setGenerationStatus(videoId, "failed", message);
      logger.error(
        { videoId, error, durationMs: Date.now() - started },
        "Storyboard generation failed"
      );
      captureTelemetryException(error, { source: "storyboard_job", videoId });
      eventsService.broadcastToAuthenticated({
        type: "storyboard:error",
        message: {
          ...videoContext,
          message,
          text: message,
          error: message,
        },
      });
      throw error;
    }
  }

  private async generateInternal(
    videoId: number,
    input?: GenerateStoryboardInput
  ): Promise<Storyboard> {
    if (env.DEMO_MODE)
      return demoMediaAssetsService.generateStoryboard(videoId, input);
    const totalStart = Date.now();
    const video = await videosService.findById(videoId);

    // Keep the current preview available until its replacement is fully rendered.
    const existing = await db
      .select()
      .from(storyboardsTable)
      .where(eq(storyboardsTable.videoId, videoId))
      .limit(1);

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

    const tileCount = Math.ceil(video.duration_seconds / intervalSeconds);

    const base = join(
      env.STORYBOARDS_DIR,
      `storyboard_${videoId}_${Date.now()}_${randomUUID()}`
    );
    const pagePaths = storyboardPagePaths(base, storyboardFormat, tileCount);
    const spritePath = pagePaths[0]!;
    const vttPath = `${base}.vtt`;

    const options: SpriteSheetOptions = {
      videoId,
      inputPath: video.file_path,
      durationSeconds: video.duration_seconds,
      sampling: input?.sampling ?? env.STORYBOARD_SAMPLING,
      outputPaths: pagePaths,
      tileWidth,
      tileHeight,
      intervalSeconds,
      format: storyboardFormat,
      quality: storyboardQuality,
    };

    let published = false;
    try {
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
          pages: pagePaths.length,
        }
      );

      const spriteSizeBytes = await this.totalSize(pagePaths);

      const duration = video.duration_seconds;
      await writeFile(
        vttPath,
        buildPagedStoryboardVtt({
          videoId,
          vttPath,
          format: storyboardFormat,
          tileWidth,
          tileHeight,
          cues: Array.from({ length: tileCount }, (_, index) => ({
            start: index * intervalSeconds,
            end: Math.min((index + 1) * intervalSeconds, duration),
          })),
        }),
        "utf-8"
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
        .onConflictDoUpdate({
          target: storyboardsTable.videoId,
          set: {
            spritePath,
            vttPath,
            tileWidth,
            tileHeight,
            tileCount,
            intervalSeconds,
            spriteSizeBytes,
            generatedAt: new Date(),
          },
        })
        .returning();
      published = true;

      const current = new Set([...pagePaths, vttPath]);
      for (const previous of existing) {
        for (const path of storyboardAssetPaths(previous)) {
          if (
            resolve(dirname(path)) === resolve(env.STORYBOARDS_DIR) &&
            basename(path).startsWith(`storyboard_${videoId}_`) &&
            !current.has(path)
          )
            await unlink(path).catch(() => {});
        }
      }

      await recordPerfStage(
        { scenario: "storyboard", videoId, mode: "generate" },
        "total",
        Date.now() - totalStart,
        { tileCount, spriteSizeBytes }
      );

      // New frames for visual search; loaded lazily to keep the import graph acyclic.
      void import("@/modules/visual-search/visual-search.jobs")
        .then(({ queueVisualIndex }) => queueVisualIndex(videoId))
        .catch(() => {});

      return this.mapToApiFormat(result[0]);
    } finally {
      if (!published) {
        await Promise.all(
          [...pagePaths, vttPath].map((path) => unlink(path).catch(() => {}))
        );
      }
    }
  }

  /**
   * Assemble storyboard pages from pre-extracted frames
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

    const base = join(env.STORYBOARDS_DIR, `storyboard_${videoId}_${Date.now()}`);
    const pagePaths = storyboardPagePaths(base, storyboardFormat, tileCount);
    const vttPath = `${base}.vtt`;

    await assembleFramePages(frames.map((frame) => frame.filePath), {
      outputPaths: pagePaths,
      tileWidth,
      tileHeight,
      format: storyboardFormat,
      quality: env.STORYBOARD_QUALITY,
    });

    const spriteSizeBytes = await this.totalSize(pagePaths);

    await writeFile(
      vttPath,
      buildPagedStoryboardVtt({
        videoId,
        vttPath,
        format: storyboardFormat,
        tileWidth,
        tileHeight,
        cues: Array.from({ length: tileCount }, (_, index) => ({
          start: index * intervalSeconds,
          end: Math.min((index + 1) * intervalSeconds, videoDuration),
        })),
      }),
      "utf-8"
    );

    // Insert into database
    const result = await db
      .insert(storyboardsTable)
      .values({
        videoId,
        spritePath: pagePaths[0]!,
        vttPath,
        tileWidth,
        tileHeight,
        tileCount,
        intervalSeconds,
        spriteSizeBytes,
      })
      .returning();

    void import("@/modules/visual-search/visual-search.jobs")
      .then(({ queueVisualIndex }) => queueVisualIndex(videoId))
      .catch(() => {});

    return this.mapToApiFormat(result[0]);
  }

  private async totalSize(paths: string[]): Promise<number> {
    const sizes = await Promise.all(paths.map(async (path) => (await stat(path)).size));
    return sizes.reduce((sum, size) => sum + size, 0);
  }

  /**
   * Generate sprite sheet image using FFmpeg.
   */
  private async generateSpriteSheet(
    options: SpriteSheetOptions
  ): Promise<void> {
    const start = Date.now();
    const result = await this.renderer.render(options);
    await recordPerfStage(
      {
        scenario: "storyboard",
        videoId: options.videoId,
        mode: "sprite_sheet",
      },
      "decode_and_tile",
      Date.now() - start,
      { ...result }
    );
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
      this.assertSingleSheet(storyboard);
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
    this.assertSingleSheet(storyboard);

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
   * The whole-sheet route only serves legacy storyboards. A client holding a
   * cached legacy VTT for a since-paged storyboard would otherwise crop page 0
   * with whole-sheet coordinates; a 404 shows no thumbnail instead.
   */
  private assertSingleSheet(storyboard: Storyboard): void {
    if (isPagedSpritePath(storyboard.sprite_path))
      throw new NotFoundError(
        "Storyboard is paged; use the pages referenced by its VTT"
      );
  }

  /**
   * One page of a paged storyboard. Legacy single-sheet storyboards only
   * have page 0, which is the whole sheet.
   */
  async getPageAsset(
    videoId: number,
    page: number
  ): Promise<{ buffer: Buffer; contentType: string }> {
    const storyboard = await this.findByVideoId(videoId);
    if (!storyboard)
      throw new NotFoundError(`Storyboard not found for video: ${videoId}`);
    const path = storyboardImagePaths(
      storyboard.sprite_path,
      storyboard.tile_count
    )[page];
    if (!path) throw new NotFoundError(`Storyboard page not found: ${page}`);
    const resolved = env.DEMO_MODE
      ? resolveDemoAssetPath(path, { mustExist: false })
      : path;
    if (!existsSync(resolved))
      throw new NotFoundError(`Storyboard page file not found: ${path}`);
    return {
      buffer: await readFile(resolved),
      contentType: resolved.endsWith(".webp")
        ? "image/webp"
        : resolved.endsWith(".png")
          ? "image/png"
          : "image/jpeg",
    };
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
      await Promise.all(
        storyboardAssetPaths({
          spritePath: storyboard.sprite_path,
          vttPath: storyboard.vtt_path,
          tileCount: storyboard.tile_count,
        }).map((path) =>
          existsSync(path) ? unlink(path) : Promise.resolve()
        )
      );
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
}

export const storyboardsService = new StoryboardsService();
