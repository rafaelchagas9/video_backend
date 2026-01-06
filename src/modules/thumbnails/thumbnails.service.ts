import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import ffmpeg from 'fluent-ffmpeg';
import { getDatabase } from '@/config/database';
import { env } from '@/config/env';
import { NotFoundError, ConflictError, InternalServerError } from '@/utils/errors';
import { videosService } from '@/modules/videos/videos.service';
import type { Thumbnail, GenerateThumbnailInput } from './thumbnails.types';

export class ThumbnailsService {
  private get db() {
    return getDatabase();
  }

  constructor() {
    // Ensure thumbnails directory exists
    if (!existsSync(env.THUMBNAILS_DIR)) {
      mkdirSync(env.THUMBNAILS_DIR, { recursive: true });
    }
  }

  async generate(videoId: number, input?: GenerateThumbnailInput): Promise<Thumbnail> {
    const video = await videosService.findById(videoId); // Ensure video exists

    const existing = this.db
      .prepare('SELECT * FROM thumbnails WHERE video_id = ?')
      .get(videoId) as Thumbnail | undefined;

    if (existing) {
      // For now, we only support one thumbnail per video based on schema
      // If we want to regenerate, we'd need to delete the old one or update it.
      // Let's assume re-generation updates the existing record.
      // But for simplicity in this phase, let's return existing or delete first.
      // Let's delete the old file and record to allow regeneration.
      await this.delete(existing.id);
    }

    const timestamp = input?.timestamp ?? env.THUMBNAIL_TIMESTAMP;
    const filename = `thumbnail_${videoId}_${Date.now()}.jpg`;
    const outputPath = join(env.THUMBNAILS_DIR, filename);

    return new Promise((resolve, reject) => {
      ffmpeg(video.file_path)
        .screenshots({
          timestamps: [timestamp],
          filename: filename,
          folder: env.THUMBNAILS_DIR,
          size: env.THUMBNAIL_SIZE,
        })
        .on('end', async () => {
          try {
            // Get file stats (size) could be added here but we'll trust ffmpeg worked
            // Let's insert into DB
            const result = this.db
              .prepare(
                `INSERT INTO thumbnails (
                  video_id, file_path, timestamp_seconds, width, height
                ) VALUES (?, ?, ?, ?, ?)`
              )
              .run(
                videoId,
                outputPath,
                timestamp,
                320, // Default width from env constant assumption or parse it
                240  // Default height
              );

            const thumbnail = await this.findById(result.lastInsertRowid as number);
            resolve(thumbnail);
          } catch (error) {
            reject(new InternalServerError('Failed to save thumbnail record'));
          }
        })
        .on('error', (err) => {
          reject(new InternalServerError(`FFmpeg error: ${err.message}`));
        });
    });
  }

  async findById(id: number): Promise<Thumbnail> {
    const thumbnail = this.db
      .prepare('SELECT * FROM thumbnails WHERE id = ?')
      .get(id) as Thumbnail | undefined;

    if (!thumbnail) {
      throw new NotFoundError(`Thumbnail not found with id: ${id}`);
    }

    return thumbnail;
  }

  async getByVideoId(videoId: number): Promise<Thumbnail[]> {
    return this.db
      .prepare('SELECT * FROM thumbnails WHERE video_id = ?')
      .all(videoId) as Thumbnail[];
  }

  async delete(id: number): Promise<void> {
    const thumbnail = await this.findById(id);
    
    // Delete file
    try {
      if (existsSync(thumbnail.file_path)) {
        // fs.unlinkSync(thumbnail.file_path); 
        // We need 'fs' imported for unlinkSync. Let's start with db delete.
        // Actually, preventing file accumulation is important.
        const fs = await import('fs');
        fs.unlinkSync(thumbnail.file_path);
      }
    } catch (error) {
      console.error(`Failed to delete thumbnail file: ${thumbnail.file_path}`, error);
      // Continue to delete record even if file deletion fails
    }

    this.db.prepare('DELETE FROM thumbnails WHERE id = ?').run(id);
  }
}

export const thumbnailsService = new ThumbnailsService();
