import { join } from "path";
import { existsSync, mkdirSync } from "fs";
import { stat } from "fs/promises";
import ffmpeg from "fluent-ffmpeg";
import { eq } from "drizzle-orm";
import { db } from "@/config/drizzle";
import { thumbnailsTable } from "@/database/schema";
import { env } from "@/config/env";
import { NotFoundError } from "@/utils/errors";
import { videosService } from "@/modules/videos/videos.service";
import { logger } from "@/utils/logger";
import type { Thumbnail, GenerateThumbnailInput } from "./thumbnails.types";
import type { ExtractedFrame } from "@/modules/frame-extraction";

export class ThumbnailsService {
  constructor() {
    // Ensure thumbnails directory exists
    if (!existsSync(env.THUMBNAILS_DIR)) {
      mkdirSync(env.THUMBNAILS_DIR, { recursive: true });
    }
  }

  async generate(
    videoId: number,
    input?: GenerateThumbnailInput,
  ): Promise<Thumbnail> {
    const video = await videosService.findById(videoId); // Ensure video exists

    const existing = await db
      .select()
      .from(thumbnailsTable)
      .where(eq(thumbnailsTable.videoId, videoId))
      .limit(1)
      .then((rows) => rows[0] || null);

    if (existing) {
      // For now, we only support one thumbnail per video based on schema
      // If we want to regenerate, we'd need to delete old one or update it.
      // Let's assume re-generation updates existing record.
      // But for simplicity in this phase, let's return existing or delete first.
      // Let's delete old file and record to allow regeneration.
      await this.delete(existing.id);
    }

    const [width, height] = env.THUMBNAIL_SIZE.split("x").map(Number);

    // Calculate timestamp from percentage or use override
    let timestamp: number;
    if (input?.timestamp !== undefined) {
      // User provided explicit timestamp (seconds)
      timestamp = input.timestamp;
    } else if (input?.positionPercent !== undefined) {
      // User provided percentage (0-100)
      if (!video.duration_seconds) {
        throw new Error(
          "Video duration not available for percentage calculation",
        );
      }
      timestamp = video.duration_seconds * (input.positionPercent / 100);
    } else {
      // Use default percentage from env
      if (!video.duration_seconds) {
        // Fallback to old fixed timestamp if duration unavailable
        timestamp = env.THUMBNAIL_TIMESTAMP;
      } else {
        timestamp =
          video.duration_seconds * (env.THUMBNAIL_POSITION_PERCENT / 100);
      }
    }

    // Validate timestamp bounds
    if (video.duration_seconds) {
      timestamp = Math.max(0, Math.min(timestamp, video.duration_seconds - 1));
    }

    const format = env.THUMBNAIL_FORMAT;
    const filename = `thumbnail_${videoId}_${Date.now()}.${format}`;
    const outputPath = join(env.THUMBNAILS_DIR, filename);

    return new Promise((resolve, reject) => {
      const stderrLines: string[] = [];

      // Build command manually instead of using .screenshots()
      // because .screenshots() uses complex filtergraph which conflicts with -vf
      const command = ffmpeg(video.file_path)
        .inputOptions([
          "-hwaccel",
          "vaapi",
          "-hwaccel_device",
          env.VAAPI_DEVICE,
        ])
        .seekInput(timestamp)
        .frames(1)
        .outputOptions([
          "-an", // no audio
          "-sn", // no subtitles
          "-dn", // no data streams
          "-vf",
          `scale=w=${width}:h=${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
          ...this.getQualityOptions(format, env.THUMBNAIL_QUALITY),
        ])
        .output(outputPath);

      command
        .on("start", (cmdLine) => {
          logger.debug({ cmd: cmdLine, videoId }, "ffmpeg thumbnail start");
        })
        .on("stderr", (line) => {
          stderrLines.push(line);
        })
        .on("end", async () => {
          try {
            // Get file size
            const stats = await stat(outputPath);
            const fileSize = stats.size;

            // Insert into DB
            const result = await db
              .insert(thumbnailsTable)
              .values({
                videoId,
                filePath: outputPath,
                fileSizeBytes: fileSize,
                timestampSeconds: timestamp,
                width,
                height,
              })
              .returning({ id: thumbnailsTable.id })
              .then((rows) => rows[0] || null);

            if (!result) {
              throw new Error("Failed to save thumbnail record");
            }

            const thumbnail = await this.findById(result.id);
            resolve(thumbnail);
          } catch (error) {
            const normalizedError =
              error instanceof Error ? error : new Error(String(error));
            reject(normalizedError);
          }
        })
        .on("error", (err, _stdout, stderr) => {
          const stderrOutput = stderr || stderrLines.join("\n");
          const message = stderrOutput || err?.message || String(err);
          const error = new Error(`FFmpeg thumbnail error: ${message}`);
          logger.error(
            { videoId, stderrOutput, originalError: err?.message },
            "ffmpeg thumbnail failed",
          );
          reject(error);
        })
        .run();
    });
  }

  /**
   * Save a thumbnail from an already-extracted frame
   * Used by unified frame extraction workflow
   */
  async saveFromFrame(
    videoId: number,
    frame: ExtractedFrame,
  ): Promise<Thumbnail> {
    // Delete existing thumbnail if present
    const existing = await db
      .select()
      .from(thumbnailsTable)
      .where(eq(thumbnailsTable.videoId, videoId))
      .limit(1)
      .then((rows) => rows[0] || null);

    if (existing) {
      await this.delete(existing.id);
    }

    const [width, height] = env.THUMBNAIL_SIZE.split("x").map(Number);

    // Generate filename and copy frame to thumbnails directory
    const format = env.THUMBNAIL_FORMAT;
    const filename = `thumbnail_${videoId}_${Date.now()}.${format}`;
    const outputPath = join(env.THUMBNAILS_DIR, filename);

    const outputOptions = this.getQualityOptions(format, env.THUMBNAIL_QUALITY);
    outputOptions.unshift(
      "-vf",
      `scale=w=${width}:h=${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
    );

    await new Promise<void>((resolve, reject) => {
      ffmpeg(frame.filePath)
        .outputOptions(outputOptions)
        .output(outputPath)
        .on("end", () => resolve())
        .on("error", (err) =>
          reject(err instanceof Error ? err : new Error(String(err))),
        )
        .run();
    });

    // Get file size
    const stats = await stat(outputPath);
    const fileSize = stats.size;

    // Insert into DB
    const result = await db
      .insert(thumbnailsTable)
      .values({
        videoId,
        filePath: outputPath,
        fileSizeBytes: fileSize,
        timestampSeconds: frame.timestampSeconds,
        width,
        height,
      })
      .returning({ id: thumbnailsTable.id })
      .then((rows) => rows[0] || null);

    if (!result) {
      throw new Error("Failed to save thumbnail record");
    }

    return await this.findById(result.id);
  }

  private getQualityOptions(format: "webp" | "jpg", quality: number): string[] {
    if (format === "webp") {
      return ["-quality", quality.toString()];
    }

    const jpegQuality = Math.round(2 + ((100 - quality) / 100) * 29);
    return ["-qscale:v", jpegQuality.toString()];
  }

  async findById(id: number): Promise<Thumbnail> {
    if (env.DEMO_MODE) {
      const { demoMockService } = await import("@/utils/demo-mock");
      const video = demoMockService.getVideoById(id);
      if (video && video.thumbnail) {
        return video.thumbnail as Thumbnail;
      }
    }
    const thumbnail = await db
      .select()
      .from(thumbnailsTable)
      .where(eq(thumbnailsTable.id, id))
      .limit(1)
      .then((rows) => rows[0] || null);

    if (!thumbnail) {
      throw new NotFoundError(`Thumbnail not found with id: ${id}`);
    }

    // Convert to snake_case format for backwards compatibility
    return {
      id: thumbnail.id,
      video_id: thumbnail.videoId,
      file_path: thumbnail.filePath,
      file_size_bytes: thumbnail.fileSizeBytes ?? 0,
      timestamp_seconds: thumbnail.timestampSeconds,
      width: thumbnail.width ?? 0,
      height: thumbnail.height ?? 0,
      generated_at: thumbnail.generatedAt.toISOString(),
    };
  }

  async getByVideoId(videoId: number): Promise<Thumbnail[]> {
    if (env.DEMO_MODE) {
      const { demoMockService } = await import("@/utils/demo-mock");
      const video = demoMockService.getVideoById(videoId);
      return video && video.thumbnail ? [video.thumbnail as Thumbnail] : [];
    }
    const thumbnails = await db
      .select()
      .from(thumbnailsTable)
      .where(eq(thumbnailsTable.videoId, videoId));

    // Convert to snake_case format for backwards compatibility
    return thumbnails.map((t) => ({
      id: t.id,
      video_id: t.videoId,
      file_path: t.filePath,
      file_size_bytes: t.fileSizeBytes ?? 0,
      timestamp_seconds: t.timestampSeconds,
      width: t.width ?? 0,
      height: t.height ?? 0,
      generated_at: t.generatedAt.toISOString(),
    }));
  }

  async delete(id: number): Promise<void> {
    const thumbnail = await this.findById(id);

    // Delete file
    try {
      if (existsSync(thumbnail.file_path)) {
        // fs.unlinkSync(thumbnail.file_path);
        // We need 'fs' imported for unlinkSync. Let's start with db delete.
        // Actually, preventing file accumulation is important.
        const fs = await import("fs");
        fs.unlinkSync(thumbnail.file_path);
      }
    } catch (error) {
      console.error(
        `Failed to delete thumbnail file: ${thumbnail.file_path}`,
        error,
      );
      // Continue to delete record even if file deletion fails
    }

    await db.delete(thumbnailsTable).where(eq(thumbnailsTable.id, id));
  }
}

export const thumbnailsService = new ThumbnailsService();
