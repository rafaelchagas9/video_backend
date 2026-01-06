import { readdir, stat } from 'fs/promises';
import { join, basename } from 'path';
import { getDatabase } from '@/config/database';
import { isVideoFile, getFileSize, computeFileHash } from '@/utils/file-utils';
import { logger } from '@/utils/logger';
import { metadataService } from '@/modules/videos/metadata.service';
import { directoriesService } from './directories.service';
import type { Video } from '@/modules/videos/videos.types';

interface ScanResult {
  files_found: number;
  files_added: number;
  files_updated: number;
  files_removed: number;
  errors: string[];
}

export class WatcherService {
  private get db() {
    return getDatabase();
  }
  private scanningDirectories = new Set<number>();

  async scanDirectory(directoryId: number): Promise<ScanResult> {
    if (this.scanningDirectories.has(directoryId)) {
      logger.warn(
        { directoryId },
        'Directory scan already in progress, skipping'
      );
      return {
        files_found: 0,
        files_added: 0,
        files_updated: 0,
        files_removed: 0,
        errors: ['Scan already in progress'],
      };
    }

    this.scanningDirectories.add(directoryId);

    try {
      const directory = await directoriesService.findById(directoryId);

      const result: ScanResult = {
        files_found: 0,
        files_added: 0,
        files_updated: 0,
        files_removed: 0,
        errors: [],
      };

      const startTime = new Date().toISOString();

      // Insert scan log
      const scanLogResult = this.db
        .prepare(
          `INSERT INTO scan_logs (directory_id, started_at)
           VALUES (?, ?)
           RETURNING id`
        )
        .get(directoryId, startTime) as { id: number };

      const scanLogId = scanLogResult.id;

      try {
        // Scan directory recursively
        const videoFiles = await this.findVideoFiles(directory.path);
        result.files_found = videoFiles.length;

        logger.info(
          { directoryId, path: directory.path, count: videoFiles.length },
          'Found video files'
        );

        // Index each video
        for (const filePath of videoFiles) {
          try {
            await this.indexVideo(filePath, directoryId);
            result.files_added++;
          } catch (error: any) {
            logger.error(
              { error, filePath },
              'Failed to index video file'
            );
            result.errors.push(`${filePath}: ${error.message}`);
          }
        }

        // Check for removed files (files in DB but not on disk anymore)
        const dbVideos = this.db
          .prepare('SELECT file_path FROM videos WHERE directory_id = ?')
          .all(directoryId) as { file_path: string }[];

        const currentFiles = new Set(videoFiles);

        for (const dbVideo of dbVideos) {
          if (!currentFiles.has(dbVideo.file_path)) {
            // Mark as unavailable
            this.db
              .prepare(
                "UPDATE videos SET is_available = 0, updated_at = datetime('now') WHERE file_path = ?"
              )
              .run(dbVideo.file_path);
            result.files_removed++;
          }
        }

        // Update scan log
        this.db
          .prepare(
            `UPDATE scan_logs
             SET completed_at = datetime('now'),
                 files_found = ?,
                 files_added = ?,
                 files_updated = ?,
                 files_removed = ?,
                 errors = ?
             WHERE id = ?`
          )
          .run(
            result.files_found,
            result.files_added,
            result.files_updated,
            result.files_removed,
            JSON.stringify(result.errors),
            scanLogId
          );

        // Update directory last scan time
        await directoriesService.updateLastScanTime(directoryId);

        logger.info({ directoryId, result }, 'Directory scan completed');

        return result;
      } catch (error: any) {
        // Update scan log with error
        this.db
          .prepare(
            `UPDATE scan_logs
             SET completed_at = datetime('now'),
                 errors = ?
             WHERE id = ?`
          )
          .run(JSON.stringify([error.message]), scanLogId);

        throw error;
      }
    } finally {
      this.scanningDirectories.delete(directoryId);
    }
  }

  private async findVideoFiles(
    directoryPath: string,
    files: string[] = []
  ): Promise<string[]> {
    try {
      const entries = await readdir(directoryPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(directoryPath, entry.name);

        if (entry.isDirectory()) {
          // Recursively scan subdirectories
          await this.findVideoFiles(fullPath, files);
        } else if (entry.isFile() && isVideoFile(fullPath)) {
          files.push(fullPath);
        }
      }

      return files;
    } catch (error: any) {
      logger.error(
        { error, path: directoryPath },
        'Failed to read directory'
      );
      throw error;
    }
  }

  private async indexVideo(
    filePath: string,
    directoryId: number
  ): Promise<Video> {
    const fileName = basename(filePath);

    // Check if video already exists
    const existing = this.db
      .prepare('SELECT id, file_size_bytes FROM videos WHERE file_path = ?')
      .get(filePath) as { id: number; file_size_bytes: number } | undefined;

    // Get file size
    const fileSize = await getFileSize(filePath);

    if (existing) {
      // Video exists, check if file size changed
      if (existing.file_size_bytes === fileSize) {
        // No change, mark as available and return
        this.db
          .prepare(
            "UPDATE videos SET is_available = 1, last_verified_at = datetime('now') WHERE id = ?"
          )
          .run(existing.id);

        return this.db
          .prepare('SELECT * FROM videos WHERE id = ?')
          .get(existing.id) as Video;
      }

      // File changed, update metadata
      logger.info({ filePath }, 'Video file changed, re-indexing');
    }

    // Extract metadata
    let metadata;
    try {
      metadata = await metadataService.extractMetadata(filePath);
    } catch (error) {
      logger.warn({ error, filePath }, 'Failed to extract video metadata');
      metadata = {
        duration_seconds: null,
        width: null,
        height: null,
        codec: null,
        bitrate: null,
        fps: null,
        audio_codec: null,
      };
    }

    // Compute file hash (async, don't block)
    let fileHash: string | null = null;
    try {
      fileHash = await computeFileHash(filePath);
    } catch (error) {
      logger.warn({ error, filePath }, 'Failed to compute file hash');
    }

    if (existing) {
      // Update existing video
      this.db
        .prepare(
          `UPDATE videos
           SET file_size_bytes = ?,
               file_hash = ?,
               duration_seconds = ?,
               width = ?,
               height = ?,
               codec = ?,
               bitrate = ?,
               fps = ?,
               audio_codec = ?,
               is_available = 1,
               last_verified_at = datetime('now'),
               updated_at = datetime('now')
           WHERE id = ?`
        )
        .run(
          fileSize,
          fileHash,
          metadata.duration_seconds,
          metadata.width,
          metadata.height,
          metadata.codec,
          metadata.bitrate,
          metadata.fps,
          metadata.audio_codec,
          existing.id
        );

      return this.db
        .prepare('SELECT * FROM videos WHERE id = ?')
        .get(existing.id) as Video;
    } else {
      // Insert new video
      const result = this.db
        .prepare(
          `INSERT INTO videos (
             file_path, file_name, directory_id, file_size_bytes, file_hash,
             duration_seconds, width, height, codec, bitrate, fps, audio_codec
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           RETURNING *`
        )
        .get(
          filePath,
          fileName,
          directoryId,
          fileSize,
          fileHash,
          metadata.duration_seconds,
          metadata.width,
          metadata.height,
          metadata.codec,
          metadata.bitrate,
          metadata.fps,
          metadata.audio_codec
        ) as Video;

      logger.info({ videoId: result.id, filePath }, 'Video indexed');

      return result;
    }
  }
}

export const watcherService = new WatcherService();
