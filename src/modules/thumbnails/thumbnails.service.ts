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
import type { Thumbnail, GenerateThumbnailInput } from "./thumbnails.types";

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

    // Parse width and height from THUMBNAIL_SIZE env variable (e.g., "320x240")
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
      const command = ffmpeg(video.file_path).screenshots({
        timestamps: [timestamp],
        filename: filename,
        folder: env.THUMBNAILS_DIR,
        size: env.THUMBNAIL_SIZE,
      });

      // Add quality settings based on format
      if (format === "webp") {
        // WebP quality (0-100 scale)
        command.outputOptions(["-quality", env.THUMBNAIL_QUALITY.toString()]);
      } else {
        // JPEG quality (2-31 scale, lower is better)
        // Convert from 0-100 scale (higher is better) to 2-31 scale (lower is better)
        const jpegQuality = Math.round(
          2 + ((100 - env.THUMBNAIL_QUALITY) / 100) * 29,
        );
        command.outputOptions(["-qscale:v", jpegQuality.toString()]);
      }

      command
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
            reject(new Error("Failed to save thumbnail record"));
          }
        })
        .on("error", (err) => {
          reject(new Error(`FFmpeg error: ${err.message}`));
        });
    });
  }

  async findById(id: number): Promise<Thumbnail> {
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
