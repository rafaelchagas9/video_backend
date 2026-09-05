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
    otherRetentionDays: number = 365
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

    // postgres-js exposes affected rows through count, including DELETEs
    // without RETURNING (whose result arrays are empty).
    const result = {
      storageDeleted: storageResult.count,
      libraryDeleted: libraryResult.count,
      contentDeleted: contentResult.count,
      usageDeleted: usageResult.count,
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
