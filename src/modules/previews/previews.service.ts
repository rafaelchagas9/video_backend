import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/config/drizzle";
import { env } from "@/config/env";
import { videoPreviewsTable } from "@/database/schema";
import { videosService } from "@/modules/videos/videos.service";
import {
  ConflictError,
  InternalServerError,
  NotFoundError,
} from "@/utils/errors";
import { logger } from "@/utils/logger";
import { captureTelemetryException } from "@/utils/telemetry";
import { PreviewRenderer, type PreviewRenderResult } from "./previews.ffmpeg";
import { demoPreviewPath, previewRenderSettings } from "./previews.settings";
import type { PreviewGenerationStatus, VideoPreview } from "./previews.types";

type Priority = "interactive" | "background";

export class PreviewsService {
  readonly renderer = new PreviewRenderer({
    ffmpegPath: env.FFMPEG_PATH,
    ffprobePath: env.FFPROBE_PATH,
    vaapiDevice: env.VAAPI_DEVICE,
  });
  private readonly generating = new Map<number, Promise<VideoPreview>>();
  private readonly processing = new Set<number>();
  private pendingQueue: number[] = [];
  private readonly states = new Map<number, PreviewGenerationStatus>();

  constructor() {
    if (!env.DEMO_MODE && !existsSync(env.PREVIEWS_DIR))
      mkdirSync(env.PREVIEWS_DIR, { recursive: true });
  }

  private setStatus(
    videoId: number,
    status: PreviewGenerationStatus["status"],
    error?: string
  ): void {
    this.states.delete(videoId);
    this.states.set(videoId, {
      video_id: videoId,
      status,
      updated_at: new Date().toISOString(),
      ...(error ? { error } : {}),
    });
    // Bound retained outcomes without dropping active work.
    for (const [id, state] of this.states) {
      if (this.states.size <= 1000) break;
      if (state.status === "ready" || state.status === "failed")
        this.states.delete(id);
    }
  }

  private mapRow(row: typeof videoPreviewsTable.$inferSelect): VideoPreview {
    return {
      video_id: row.videoId,
      file_size_bytes: row.fileSizeBytes,
      duration_seconds: row.durationSeconds,
      clip_count: row.clipCount,
      width: row.width,
      height: row.height,
      has_audio: row.hasAudio,
      generated_at:
        row.generatedAt instanceof Date
          ? row.generatedAt.toISOString()
          : String(row.generatedAt),
    };
  }

  async findByVideoId(videoId: number): Promise<VideoPreview | null> {
    if (env.DEMO_MODE) {
      const path = await this.demoFile(videoId);
      if (!path) return null;
      const stats = await stat(path);
      return {
        video_id: videoId,
        file_size_bytes: stats.size,
        duration_seconds: 0,
        clip_count: 0,
        width: 0,
        height: 0,
        has_audio: true,
        generated_at: stats.mtime.toISOString(),
      };
    }
    const [row] = await db
      .select()
      .from(videoPreviewsTable)
      .where(eq(videoPreviewsTable.videoId, videoId))
      .limit(1);
    return row ? this.mapRow(row) : null;
  }

  /** Absolute path of a playable preview, or NotFound. */
  async getFilePath(videoId: number): Promise<string> {
    if (env.DEMO_MODE) {
      const path = await this.demoFile(videoId);
      if (!path) throw new NotFoundError(`Preview not found for video: ${videoId}`);
      return path;
    }
    const [row] = await db
      .select({ filePath: videoPreviewsTable.filePath })
      .from(videoPreviewsTable)
      .where(eq(videoPreviewsTable.videoId, videoId))
      .limit(1);
    if (!row || !existsSync(row.filePath))
      throw new NotFoundError(`Preview not found for video: ${videoId}`);
    return row.filePath;
  }

  private async demoFile(videoId: number): Promise<string | null> {
    const video = await videosService.findFilePathById(videoId);
    const path = resolve(demoPreviewPath(video.file_path));
    return existsSync(path) ? path : null;
  }

  /** Videos whose preview row points at a readable file. */
  async processedIds(videoIds: number[]): Promise<Set<number>> {
    if (!videoIds.length) return new Set();
    const rows = await db
      .select({
        videoId: videoPreviewsTable.videoId,
        filePath: videoPreviewsTable.filePath,
      })
      .from(videoPreviewsTable)
      .where(inArray(videoPreviewsTable.videoId, videoIds));
    return new Set(
      rows.filter((row) => existsSync(row.filePath)).map((row) => row.videoId)
    );
  }

  async getGenerationStatus(videoId: number): Promise<PreviewGenerationStatus> {
    await videosService.findById(videoId);
    if (!env.DEMO_MODE) {
      const active = this.states.get(videoId);
      if (active && active.status !== "ready") return active;
    }
    const preview = await this.findByVideoId(videoId);
    return {
      video_id: videoId,
      status: preview ? "ready" : "idle",
      updated_at: preview?.generated_at ?? null,
    };
  }

  /** Queue generation for new videos; the queue is bounded by PREVIEW_MAX_CONCURRENT. */
  async queueGenerate(videoId: number, force = false): Promise<void> {
    if (env.DEMO_MODE) return;
    if (
      this.processing.has(videoId) ||
      this.generating.has(videoId) ||
      this.pendingQueue.includes(videoId)
    )
      return;
    if (!force && (await this.findByVideoId(videoId))) return;
    await videosService.findById(videoId);
    // Recheck after the database reads: simultaneous requests can race.
    if (
      this.processing.has(videoId) ||
      this.generating.has(videoId) ||
      this.pendingQueue.includes(videoId)
    )
      return;
    this.pendingQueue.push(videoId);
    this.setStatus(videoId, "queued");
    this.processQueue();
  }

  private processQueue(): void {
    while (
      this.pendingQueue.length > 0 &&
      this.processing.size < env.PREVIEW_MAX_CONCURRENT
    ) {
      const videoId = this.pendingQueue.shift()!;
      this.processing.add(videoId);
      void this.generate(videoId, { priority: "background" })
        .catch(() => {
          // generate() records and reports the failure.
        })
        .finally(() => {
          this.processing.delete(videoId);
          this.processQueue();
        });
    }
  }

  /** Render (or re-render) a video's preview. Concurrent calls join one job. */
  generate(
    videoId: number,
    options: { priority?: Priority; signal?: AbortSignal } = {}
  ): Promise<VideoPreview> {
    if (env.DEMO_MODE)
      return Promise.reject(
        new InternalServerError("Previews are pre-generated in demo mode")
      );
    const active = this.generating.get(videoId);
    if (active) return active;
    const pending = this.runGeneration(
      videoId,
      options.priority ?? "interactive",
      options.signal
    ).finally(() => this.generating.delete(videoId));
    this.generating.set(videoId, pending);
    return pending;
  }

  private async runGeneration(
    videoId: number,
    priority: Priority,
    signal?: AbortSignal
  ): Promise<VideoPreview> {
    this.setStatus(videoId, "processing");
    const started = Date.now();
    try {
      const video = await videosService.findById(videoId);
      if (!video.duration_seconds || video.duration_seconds <= 0)
        throw new InternalServerError(
          "Video duration not available for preview generation"
        );
      const existing = await db
        .select({ filePath: videoPreviewsTable.filePath })
        .from(videoPreviewsTable)
        .where(eq(videoPreviewsTable.videoId, videoId));
      const outputPath = join(
        env.PREVIEWS_DIR,
        `preview_${videoId}_${Date.now()}_${randomUUID()}.mp4`
      );
      let published = false;
      try {
        const result = await this.renderer.render(
          {
            inputPath: video.file_path,
            outputPath,
            durationSeconds: video.duration_seconds,
            hasAudio: Boolean(video.audio_codec),
            ...previewRenderSettings(),
          },
          priority,
          signal
        );
        const [row] = await this.upsert(videoId, outputPath, result);
        published = true;
        for (const previous of existing) {
          if (
            previous.filePath !== outputPath &&
            resolve(dirname(previous.filePath)) === resolve(env.PREVIEWS_DIR) &&
            basename(previous.filePath).startsWith(`preview_${videoId}_`)
          )
            await unlink(previous.filePath).catch(() => {});
        }
        this.setStatus(videoId, "ready");
        logger.info(
          {
            videoId,
            durationMs: Date.now() - started,
            sizeBytes: result.sizeBytes,
            clipCount: result.clipCount,
            hardwareDecode: result.hardwareDecode,
          },
          "Preview generation completed"
        );
        return this.mapRow(row!);
      } finally {
        if (!published) await unlink(outputPath).catch(() => {});
      }
    } catch (error) {
      if (signal?.aborted) {
        this.setStatus(videoId, "idle");
        throw error;
      }
      const message = "Preview generation failed. Please try again.";
      this.setStatus(videoId, "failed", message);
      logger.error(
        { videoId, error, durationMs: Date.now() - started },
        "Preview generation failed"
      );
      captureTelemetryException(error, { source: "preview_job", videoId });
      throw error;
    }
  }

  private upsert(
    videoId: number,
    filePath: string,
    result: PreviewRenderResult
  ) {
    const values = {
      filePath,
      fileSizeBytes: result.sizeBytes,
      durationSeconds: result.durationSeconds,
      clipCount: result.clipCount,
      width: result.width,
      height: result.height,
      hasAudio: result.hasAudio,
      generatedAt: new Date(),
    };
    return db
      .insert(videoPreviewsTable)
      .values({ videoId, ...values })
      .onConflictDoUpdate({ target: videoPreviewsTable.videoId, set: values })
      .returning();
  }

  async delete(videoId: number): Promise<void> {
    if (env.DEMO_MODE)
      throw new ConflictError("Demo previews are pre-generated and read-only");
    const [row] = await db
      .select({ filePath: videoPreviewsTable.filePath })
      .from(videoPreviewsTable)
      .where(eq(videoPreviewsTable.videoId, videoId))
      .limit(1);
    if (!row) throw new NotFoundError(`Preview not found for video: ${videoId}`);
    await unlink(row.filePath).catch((error) =>
      logger.warn({ videoId, error }, "Could not delete preview file")
    );
    await db
      .delete(videoPreviewsTable)
      .where(eq(videoPreviewsTable.videoId, videoId));
  }
}

export const previewsService = new PreviewsService();
