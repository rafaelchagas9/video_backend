/**
 * Conversion batch service
 * Handles batch tracking and completion notifications
 */
import { dirname } from "path";
import { conversionJobsService } from "./conversion.jobs.service";
import { logger } from "@/utils/logger";
import { websocketService } from "@/modules/websocket/websocket";
import type { ConversionEvent } from "./conversion.types";

export class ConversionBatchService {
  /**
   * Check if a batch is complete and trigger actions
   */
  async checkBatchCompletion(batchId: string): Promise<void> {
    // Check if any jobs in this batch are still pending or processing
    const pendingCount =
      await conversionJobsService.countPendingInBatch(batchId);

    if (pendingCount > 0) {
      return; // Batch not finished
    }

    logger.info({ batchId }, "Batch conversion completed");

    // Get statistics
    const stats = await conversionJobsService.getBatchStats(batchId);

    // Emit Batch Completed Event
    this.emitEvent({
      type: "conversion:batch_completed",
      message: {
        jobId: 0,
        videoId: 0,
        preset: "batch",
        stats: {
          total: stats.total,
          completed: stats.completed,
          failed: stats.failed,
        },
      },
    });

    // Trigger Directory Scans
    await this.triggerDirectoryScans(batchId);
  }

  /**
   * Trigger directory scans for all directories involved in a batch
   */
  private async triggerDirectoryScans(batchId: string): Promise<void> {
    // Get all output paths for this batch
    const outputPaths =
      await conversionJobsService.getBatchOutputPaths(batchId);

    const dirsToScan = new Set<string>();
    for (const path of outputPaths) {
      if (path) {
        dirsToScan.add(dirname(path));
      }
    }

    // Resolve these paths to directory IDs and trigger scans
    const { directoriesService } =
      await import("@/modules/directories/directories.service");
    const { watcherService } =
      await import("@/modules/directories/watcher.service");

    const allDirs = await directoriesService.findAll();

    for (const dirPath of dirsToScan) {
      // Find matching watched directory
      const matchedDir = allDirs.find((d) => dirPath.startsWith(d.path));
      if (matchedDir) {
        logger.info(
          { batchId, directoryId: matchedDir.id },
          "Triggering directory scan after batch",
        );
        // Fire and forget
        watcherService.scanDirectory(matchedDir.id).catch((err) => {
          logger.error(
            { err, directoryId: matchedDir.id },
            "Failed to scan directory after batch",
          );
        });
      }
    }
  }

  /**
   * Emit WebSocket event
   */
  private emitEvent(event: ConversionEvent): void {
    try {
      websocketService.broadcast(event);
    } catch (error) {
      logger.error({ error }, "Failed to emit WebSocket event");
    }
  }
}

export const conversionBatchService = new ConversionBatchService();
