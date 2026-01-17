import { readdir } from "fs/promises";
import { join, basename } from "path";
import { db } from "@/config/drizzle";
import { scanLogsTable, videosTable } from "@/database/schema";
import { eq, and, ne } from "drizzle-orm";
import {
  isVideoFile,
  getFileSize,
  computeFileHash,
  computeFullHash,
} from "@/utils/file-utils";
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

      const startTime = new Date();

      // Insert scan log
      const [scanLogResult] = await db
        .insert(scanLogsTable)
        .values({
          directoryId,
          startedAt: startTime,
        })
        .returning({ id: scanLogsTable.id });

      if (!scanLogResult) {
        throw new Error("Failed to create scan log");
      }

      const scanLogId = scanLogResult.id;

      try {
        // Scan directory recursively
        logger.info(
          { directoryId, path: directory.path },
          "Scanning for video files...",
        );
        const findFilesStartTime = Date.now();
        const videoFiles = await this.findVideoFiles(directory.path);
        const findFilesDuration = Date.now() - findFilesStartTime;
        result.files_found = videoFiles.length;

        logger.info(
          {
            directoryId,
            path: directory.path,
            count: videoFiles.length,
            durationMs: findFilesDuration,
          },
          `Found ${videoFiles.length} video files in ${(findFilesDuration / 1000).toFixed(2)}s`,
        );

        // Index each video
        logger.info(
          { directoryId, totalFiles: videoFiles.length },
          "Starting video indexing...",
        );
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
                  estimatedTimeLeftSeconds: Math.round(estimatedTimeLeft),
                },
                `Indexed ${i + 1}/${videoFiles.length} files (ETA: ${Math.round(estimatedTimeLeft)}s)`,
              );
            }
          } catch (error: any) {
            logger.error(
              { error, filePath, index: i + 1, total: videoFiles.length },
              "Failed to index video file",
            );
            result.errors.push(`${filePath}: ${error.message}`);
          }
        }

        const totalIndexDuration = Date.now() - indexStartTime;
        logger.info(
          {
            directoryId,
            filesIndexed: result.files_added,
            durationMs: totalIndexDuration,
          },
          `Indexed ${result.files_added} files in ${(totalIndexDuration / 1000).toFixed(2)}s`,
        );

        // Check for removed files (files in DB but not on disk anymore)
        logger.debug({ directoryId }, "Checking for removed files...");
        const dbVideos = await db
          .select({ filePath: videosTable.filePath })
          .from(videosTable)
          .where(eq(videosTable.directoryId, directoryId));

        const currentFiles = new Set(videoFiles);

        for (const dbVideo of dbVideos) {
          if (!currentFiles.has(dbVideo.filePath)) {
            // Mark as unavailable
            await db
              .update(videosTable)
              .set({
                isAvailable: false,
                updatedAt: new Date(),
              })
              .where(eq(videosTable.filePath, dbVideo.filePath));

            result.files_removed++;
            logger.debug(
              { filePath: dbVideo.filePath },
              "Marked file as unavailable",
            );
          }
        }

        if (result.files_removed > 0) {
          logger.info(
            { directoryId, filesRemoved: result.files_removed },
            `Marked ${result.files_removed} files as unavailable`,
          );
        }

        // Update scan log
        await db
          .update(scanLogsTable)
          .set({
            completedAt: new Date(),
            filesFound: result.files_found,
            filesAdded: result.files_added,
            filesUpdated: result.files_updated,
            filesRemoved: result.files_removed,
            errors: JSON.stringify(result.errors),
          })
          .where(eq(scanLogsTable.id, scanLogId));

        // Update directory last scan time
        await directoriesService.updateLastScanTime(directoryId);

        const totalScanDuration = Date.now() - scanStartTime;
        logger.info(
          {
            directoryId,
            result,
            totalDurationMs: totalScanDuration,
            totalDurationSeconds: (totalScanDuration / 1000).toFixed(2),
          },
          `Directory scan completed in ${(totalScanDuration / 1000).toFixed(2)}s - Found: ${result.files_found}, Added: ${result.files_added}, Removed: ${result.files_removed}, Errors: ${result.errors.length}`,
        );

        return result;
      } catch (error: any) {
        // Update scan log with error
        await db
          .update(scanLogsTable)
          .set({
            completedAt: new Date(),
            errors: JSON.stringify([error.message]),
          })
          .where(eq(scanLogsTable.id, scanLogId));

        throw error;
      }
    } finally {
      // Process any queued storyboards (this is safe to await here as it handles its own errors)
      // We do this in finally to ensure we process even if scan had partial errors,
      // but only if we have compiled a list of new videos
      await this.processStoryboardQueue();

      this.scanningDirectories.delete(directoryId);
    }
  }

  // Queue to track new videos during a scan run
  private newVideoIds: number[] = [];

  private async processStoryboardQueue() {
    if (this.newVideoIds.length === 0) return;

    logger.info(
      { count: this.newVideoIds.length },
      "Queueing post-scan storyboard generation...",
    );

    const { storyboardsService } =
      await import("@/modules/storyboards/storyboards.service");

    // Add all new videos to the centralized queue
    // The queue handles deduplication and sequential processing
    for (const videoId of this.newVideoIds) {
      storyboardsService.queueGenerate(videoId);
    }

    logger.info(
      { count: this.newVideoIds.length },
      "Videos queued for storyboard generation",
    );

    // Clear local queue
    this.newVideoIds = [];
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
    let isNewVideo = false;

    // Check if video already exists
    const dbCheckStart = Date.now();
    const [existing] = await db
      .select({
        id: videosTable.id,
        fileSizeBytes: videosTable.fileSizeBytes,
      })
      .from(videosTable)
      .where(eq(videosTable.filePath, filePath))
      .limit(1);
    const dbCheckDuration = Date.now() - dbCheckStart;

    logger.debug(
      { filePath, durationMs: dbCheckDuration },
      `DB check completed in ${dbCheckDuration}ms`,
    );

    // Get file size
    const fileSizeStart = Date.now();
    const fileSize = await getFileSize(filePath);
    const fileSizeDuration = Date.now() - fileSizeStart;

    logger.debug(
      { filePath, fileSize, durationMs: fileSizeDuration },
      `File size retrieved in ${fileSizeDuration}ms`,
    );

    if (existing && existing.fileSizeBytes === fileSize) {
      // Case 1: Existing video, unchanged
      videoId = existing.id;
      await db
        .update(videosTable)
        .set({
          isAvailable: true,
          lastVerifiedAt: new Date(),
        })
        .where(eq(videosTable.id, videoId));
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
        logger.warn(
          { error, filePath, durationMs: metadataDuration },
          "Failed to extract video metadata",
        );
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

      // Compute file hash with collision detection
      let fileHash: string | null = null;
      const hashStart = Date.now();
      let hashMethod = "partial";

      try {
        logger.debug(
          { filePath, fileSizeGB: (fileSize / 1024 ** 3).toFixed(2) },
          "Computing partial file hash...",
        );

        // Step 1: Compute partial hash (fast)
        const partialHash = await computeFileHash(filePath);

        // Step 2: Check for collision in database
        const [collision] = await db
          .select({
            id: videosTable.id,
            filePath: videosTable.filePath,
          })
          .from(videosTable)
          .where(
            and(
              eq(videosTable.fileHash, partialHash),
              ne(videosTable.filePath, filePath),
            ),
          )
          .limit(1);

        if (collision) {
          // Collision detected! Compute full hash for both files
          logger.warn(
            {
              currentFile: filePath,
              collidingFile: collision.filePath,
              partialHash,
            },
            "Partial hash collision detected, computing full hash",
          );

          hashMethod = "full";
          fileHash = await computeFullHash(filePath);

          // Also recompute full hash for colliding file and update it
          const collidingFileFullHash = await computeFullHash(
            collision.filePath,
          );
          await db
            .update(videosTable)
            .set({ fileHash: collidingFileFullHash })
            .where(eq(videosTable.id, collision.id));

          logger.info(
            {
              currentFile: filePath,
              currentHash: fileHash,
              collidingFile: collision.filePath,
              collidingHash: collidingFileFullHash,
            },
            "Resolved hash collision with full hashes",
          );
        } else {
          // No collision, use partial hash
          fileHash = partialHash;
        }

        const hashDuration = Date.now() - hashStart;

        if (hashDuration > 2000) {
          logger.warn(
            {
              filePath,
              durationMs: hashDuration,
              fileSizeGB: (fileSize / 1024 ** 3).toFixed(2),
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
        logger.warn(
          { error, filePath, durationMs: hashDuration },
          "Failed to compute file hash",
        );
      }

      if (existing) {
        // Update existing
        videoId = existing.id;
        logger.info({ filePath }, "Video file changed, re-indexing");
        await db
          .update(videosTable)
          .set({
            fileSizeBytes: fileSize,
            fileHash,
            durationSeconds: metadata.duration_seconds,
            width: metadata.width,
            height: metadata.height,
            codec: metadata.codec,
            bitrate: metadata.bitrate,
            fps: metadata.fps,
            audioCodec: metadata.audio_codec,
            isAvailable: true,
            lastVerifiedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(videosTable.id, videoId));
      } else {
        // Insert new
        const [result] = await db
          .insert(videosTable)
          .values({
            filePath,
            fileName,
            directoryId,
            fileSizeBytes: fileSize,
            fileHash,
            durationSeconds: metadata.duration_seconds,
            width: metadata.width,
            height: metadata.height,
            codec: metadata.codec,
            bitrate: metadata.bitrate,
            fps: metadata.fps,
            audioCodec: metadata.audio_codec,
          })
          .returning({ id: videosTable.id });

        if (!result) {
          throw new Error("Failed to create video record");
        }

        videoId = result.id;
        isNewVideo = true;
        logger.info({ videoId, filePath }, "Video indexed");
      }
    }

    // Check for regular thumbnail and generate if missing
    const hasThumbnail = await db.query.thumbnailsTable.findFirst({
      where: (thumbnails, { eq }) => eq(thumbnails.videoId, videoId),
      columns: { id: true },
    });

    if (!hasThumbnail) {
      logger.debug({ videoId, filePath }, "Scheduling thumbnail generation");
      thumbnailsService.generate(videoId).catch((err) => {
        logger.error(
          { videoId, err },
          "Failed to generate thumbnail during indexing",
        );
      });
    }

    // If new video, add to storyboard queue
    if (isNewVideo) {
      this.newVideoIds.push(videoId);
    }

    const totalFileDuration = Date.now() - fileStartTime;
    if (totalFileDuration > 5000) {
      logger.warn(
        { filePath, videoId, durationMs: totalFileDuration },
        `File indexing took ${(totalFileDuration / 1000).toFixed(2)}s - this file may be causing slowness`,
      );
    }

    const video = await db.query.videosTable.findFirst({
      where: (videos, { eq }) => eq(videos.id, videoId),
    });

    if (!video) {
      throw new Error("Video not found after indexing");
    }

    return {
      id: video.id,
      file_path: video.filePath,
      file_name: video.fileName,
      directory_id: video.directoryId,
      file_size_bytes: video.fileSizeBytes,
      file_hash: video.fileHash,
      duration_seconds: video.durationSeconds,
      width: video.width,
      height: video.height,
      codec: video.codec,
      bitrate: video.bitrate,
      fps: video.fps,
      audio_codec: video.audioCodec,
      title: video.title,
      description: video.description,
      themes: video.themes,
      is_available: video.isAvailable,
      last_verified_at: video.lastVerifiedAt?.toISOString() ?? null,
      indexed_at: video.indexedAt.toISOString(),
      created_at: video.createdAt.toISOString(),
      updated_at: video.updatedAt.toISOString(),
      is_favorite: false, // Default - would need to query favorites table for actual value
    };
  }
}

export const watcherService = new WatcherService();
