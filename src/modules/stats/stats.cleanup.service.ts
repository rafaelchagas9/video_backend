import { sql } from "drizzle-orm";
import { db } from "@/config/drizzle";
import { logger } from "@/utils/logger";

/**
 * Statistics cleanup service
 * Handles snapshot retention policies and cleanup
 */
export class StatsCleanupService {
  /**
   * Clean up old snapshots based on retention policy
   */
  async cleanupOldSnapshots(
    storageRetentionDays: number = 90,
    otherRetentionDays: number = 365,
  ): Promise<{
    storageDeleted: number;
    libraryDeleted: number;
    contentDeleted: number;
    usageDeleted: number;
  }> {
    // Delete old storage snapshots
    const storageQuery = sql`
      DELETE FROM stats_storage_snapshots
      WHERE created_at < NOW() - INTERVAL '1 day' * ${storageRetentionDays}
    `;
    const storageResult = await db.execute(storageQuery);

    // Delete old library snapshots
    const libraryQuery = sql`
      DELETE FROM stats_library_snapshots
      WHERE created_at < NOW() - INTERVAL '1 day' * ${otherRetentionDays}
    `;
    const libraryResult = await db.execute(libraryQuery);

    // Delete old content snapshots
    const contentQuery = sql`
      DELETE FROM stats_content_snapshots
      WHERE created_at < NOW() - INTERVAL '1 day' * ${otherRetentionDays}
    `;
    const contentResult = await db.execute(contentQuery);

    // Delete old usage snapshots
    const usageQuery = sql`
      DELETE FROM stats_usage_snapshots
      WHERE created_at < NOW() - INTERVAL '1 day' * ${otherRetentionDays}
    `;
    const usageResult = await db.execute(usageQuery);

    // Count deleted rows (estimating from array length if rowCount unavailable)
    const result = {
      storageDeleted: (storageResult as any).rowCount || 0,
      libraryDeleted: (libraryResult as any).rowCount || 0,
      contentDeleted: (contentResult as any).rowCount || 0,
      usageDeleted: (usageResult as any).rowCount || 0,
    };

    if (
      result.storageDeleted +
        result.libraryDeleted +
        result.contentDeleted +
        result.usageDeleted >
      0
    ) {
      logger.info(result, "Old stats snapshots cleaned up");
    }

    return result;
  }
}

export const statsCleanupService = new StatsCleanupService();
