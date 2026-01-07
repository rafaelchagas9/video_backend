import { readdir } from "fs/promises";
import { join, basename } from "path";
import { getDatabase } from "@/config/database";
import { isVideoFile, getFileSize, computeFileHash } from "@/utils/file-utils";
import { logger } from "@/utils/logger";
import { metadataService } from "@/modules/videos/metadata.service";
import { directoriesService } from "./directories.service";
import { thumbnailsService } from "@/modules/thumbnails/thumbnails.service";
import type { Video } from "@/modules/videos/videos.types";

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
        "Directory scan already in progress, skipping",
      );
      return {
        files_found: 0,
        files_added: 0,
        files_updated: 0,
        files_removed: 0,
        errors: ["Scan already in progress"],
      };
    }

    this.scanningDirectories.add(directoryId);

    const scanStartTime = Date.now();
    logger.info({ directoryId }, "Starting directory scan");

    try {
      const directory = await directoriesService.findById(directoryId);
      logger.debug({ directoryId, path: directory.path }, "Directory loaded");

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
           RETURNING id`,
        )
        .get(directoryId, startTime) as { id: number };

      const scanLogId = scanLogResult.id;

      try {
        // Scan directory recursively
        logger.info({ directoryId, path: directory.path }, "Scanning for video files...");
        const findFilesStartTime = Date.now();
        const videoFiles = await this.findVideoFiles(directory.path);
        const findFilesDuration = Date.now() - findFilesStartTime;
        result.files_found = videoFiles.length;

        logger.info(
          { directoryId, path: directory.path, count: videoFiles.length, durationMs: findFilesDuration },
          `Found ${videoFiles.length} video files in ${(findFilesDuration / 1000).toFixed(2)}s`,
        );

        // Index each video
        logger.info({ directoryId, totalFiles: videoFiles.length }, "Starting video indexing...");
        const indexStartTime = Date.now();
        
        for (let i = 0; i < videoFiles.length; i++) {
          const filePath = videoFiles[i];
          const fileIndexStartTime = Date.now();
          
          try {
            await this.indexVideo(filePath, directoryId);
            const fileIndexDuration = Date.now() - fileIndexStartTime;
            result.files_added++;
            
            // Log progress every 10 files or if a file takes too long
            if ((i + 1) % 10 === 0 || fileIndexDuration > 5000) {
              const avgTime = (Date.now() - indexStartTime) / (i + 1);
              const remaining = videoFiles.length - (i + 1);
              const estimatedTimeLeft = (avgTime * remaining) / 1000;
              
              logger.info(
                { 
                  directoryId,
                  progress: `${i + 1}/${videoFiles.length}`,
                  fileIndexDurationMs: fileIndexDuration,
                  avgTimePerFileMs: Math.round(avgTime),
                  estimatedTimeLeftSeconds: Math.round(estimatedTimeLeft)
                },
                `Indexed ${i + 1}/${videoFiles.length} files (ETA: ${Math.round(estimatedTimeLeft)}s)`,
              );
            }
          } catch (error: any) {
            logger.error({ error, filePath, index: i + 1, total: videoFiles.length }, "Failed to index video file");
            result.errors.push(`${filePath}: ${error.message}`);
          }
        }
        
        const totalIndexDuration = Date.now() - indexStartTime;
        logger.info(
          { directoryId, filesIndexed: result.files_added, durationMs: totalIndexDuration },
          `Indexed ${result.files_added} files in ${(totalIndexDuration / 1000).toFixed(2)}s`,
        );

        // Check for removed files (files in DB but not on disk anymore)
        logger.debug({ directoryId }, "Checking for removed files...");
        const dbVideos = this.db
          .prepare("SELECT file_path FROM videos WHERE directory_id = ?")
          .all(directoryId) as { file_path: string }[];

        const currentFiles = new Set(videoFiles);

        for (const dbVideo of dbVideos) {
          if (!currentFiles.has(dbVideo.file_path)) {
            // Mark as unavailable
            this.db
              .prepare(
                "UPDATE videos SET is_available = 0, updated_at = datetime('now') WHERE file_path = ?",
              )
              .run(dbVideo.file_path);
            result.files_removed++;
            logger.debug({ filePath: dbVideo.file_path }, "Marked file as unavailable");
          }
        }
        
        if (result.files_removed > 0) {
          logger.info({ directoryId, filesRemoved: result.files_removed }, `Marked ${result.files_removed} files as unavailable`);
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
             WHERE id = ?`,
          )
          .run(
            result.files_found,
            result.files_added,
            result.files_updated,
            result.files_removed,
            JSON.stringify(result.errors),
            scanLogId,
          );

        // Update directory last scan time
        await directoriesService.updateLastScanTime(directoryId);

        const totalScanDuration = Date.now() - scanStartTime;
        logger.info(
          { 
            directoryId, 
            result,
            totalDurationMs: totalScanDuration,
            totalDurationSeconds: (totalScanDuration / 1000).toFixed(2)
          }, 
          `Directory scan completed in ${(totalScanDuration / 1000).toFixed(2)}s - Found: ${result.files_found}, Added: ${result.files_added}, Removed: ${result.files_removed}, Errors: ${result.errors.length}`,
        );

        return result;
      } catch (error: any) {
        // Update scan log with error
        this.db
          .prepare(
            `UPDATE scan_logs
             SET completed_at = datetime('now'),
                 errors = ?
             WHERE id = ?`,
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
    files: string[] = [],
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
      logger.error({ error, path: directoryPath }, "Failed to read directory");
      throw error;
    }
  }

  private async indexVideo(
    filePath: string,
    directoryId: number,
  ): Promise<Video> {
    const fileName = basename(filePath);
    const fileStartTime = Date.now();
    let videoId: number;

    // Check if video already exists
    const dbCheckStart = Date.now();
    const existing = this.db
      .prepare("SELECT id, file_size_bytes FROM videos WHERE file_path = ?")
      .get(filePath) as { id: number; file_size_bytes: number } | undefined;
    const dbCheckDuration = Date.now() - dbCheckStart;
    
    logger.debug({ filePath, durationMs: dbCheckDuration }, `DB check completed in ${dbCheckDuration}ms`);

    // Get file size
    const fileSizeStart = Date.now();
    const fileSize = await getFileSize(filePath);
    const fileSizeDuration = Date.now() - fileSizeStart;
    
    logger.debug({ filePath, fileSize, durationMs: fileSizeDuration }, `File size retrieved in ${fileSizeDuration}ms`);

    if (existing && existing.file_size_bytes === fileSize) {
      // Case 1: Existing video, unchanged
      videoId = existing.id;
      this.db
        .prepare(
          "UPDATE videos SET is_available = 1, last_verified_at = datetime('now') WHERE id = ?",
        )
        .run(videoId);
    } else {
      // Case 2: New video OR Existing video with changed size
      // Extract metadata
      let metadata;
      const metadataStart = Date.now();
      try {
        logger.debug({ filePath }, "Extracting metadata...");
        metadata = await metadataService.extractMetadata(filePath);
        const metadataDuration = Date.now() - metadataStart;
        
        if (metadataDuration > 3000) {
          logger.warn(
            { filePath, durationMs: metadataDuration },
            `Metadata extraction took ${(metadataDuration / 1000).toFixed(2)}s - consider optimization`,
          );
        } else {
          logger.debug(
            { filePath, durationMs: metadataDuration },
            `Metadata extracted in ${metadataDuration}ms`,
          );
        }
      } catch (error) {
        const metadataDuration = Date.now() - metadataStart;
        logger.warn({ error, filePath, durationMs: metadataDuration }, "Failed to extract video metadata");
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
      const hashStart = Date.now();
      const PARTIAL_HASH_THRESHOLD = 1 * 1024 * 1024 * 1024; // 2GB
      const hashMethod = fileSize >= PARTIAL_HASH_THRESHOLD ? 'partial' : 'full';
      
      try {
        logger.debug(
          { filePath, fileSizeGB: (fileSize / (1024 ** 3)).toFixed(2), method: hashMethod },
          `Computing file hash (${hashMethod})...`,
        );
        fileHash = await computeFileHash(filePath);
        const hashDuration = Date.now() - hashStart;
        
        if (hashDuration > 2000) {
          logger.warn(
            { 
              filePath, 
              durationMs: hashDuration, 
              fileSizeGB: (fileSize / (1024 ** 3)).toFixed(2),
              method: hashMethod,
            },
            `Hash computation took ${(hashDuration / 1000).toFixed(2)}s using ${hashMethod} hashing`,
          );
        } else {
          logger.debug(
            { filePath, durationMs: hashDuration, method: hashMethod },
            `Hash computed in ${hashDuration}ms using ${hashMethod} hashing`,
          );
        }
      } catch (error) {
        const hashDuration = Date.now() - hashStart;
        logger.warn({ error, filePath, durationMs: hashDuration }, "Failed to compute file hash");
      }

      if (existing) {
        // Update existing
        videoId = existing.id;
        logger.info({ filePath }, "Video file changed, re-indexing");
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
             WHERE id = ?`,
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
            videoId,
          );
      } else {
        // Insert new
        const result = this.db
          .prepare(
            `INSERT INTO videos (
               file_path, file_name, directory_id, file_size_bytes, file_hash,
               duration_seconds, width, height, codec, bitrate, fps, audio_codec
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             RETURNING id`,
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
            metadata.audio_codec,
          ) as { id: number };
        videoId = result.id;
        logger.info({ videoId, filePath }, "Video indexed");
      }
    }

    // Check for thumbnail and generate if missing
    const hasThumbnail = this.db
      .prepare("SELECT 1 FROM thumbnails WHERE video_id = ?")
      .get(videoId);

    if (!hasThumbnail) {
      logger.debug({ videoId, filePath }, "Scheduling thumbnail generation");
      thumbnailsService.generate(videoId).catch((err) => {
        logger.error(
          { videoId, err },
          "Failed to generate thumbnail during indexing",
        );
      });
    }

    const totalFileDuration = Date.now() - fileStartTime;
    if (totalFileDuration > 5000) {
      logger.warn(
        { filePath, videoId, durationMs: totalFileDuration },
        `File indexing took ${(totalFileDuration / 1000).toFixed(2)}s - this file may be causing slowness`,
      );
    }

    return this.db
      .prepare("SELECT * FROM videos WHERE id = ?")
      .get(videoId) as Video;
  }
}

export const watcherService = new WatcherService();
