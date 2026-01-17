import { existsSync, statSync, readdirSync } from "fs";
import { resolve, join } from "path";
import { sql } from "drizzle-orm";
import { db } from "@/config/drizzle";
import { statsStorageSnapshotsTable } from "@/database/schema";
import { env } from "@/config/env";
import { logger } from "@/utils/logger";
import type {
  CurrentStorageStats,
  DirectoryStorageInfo,
  StorageSnapshot,
} from "./stats.types";

/**
 * Storage statistics service
 * Handles storage tracking, snapshots, and filesystem monitoring
 */
export class StorageStatsService {
  /**
   * Get size of a directory recursively
   */
  private getDirectorySize(dirPath: string): number {
    const fullPath = resolve(process.cwd(), dirPath);

    if (!existsSync(fullPath)) {
      return 0;
    }

    let totalSize = 0;

    try {
      const items = readdirSync(fullPath, { withFileTypes: true });

      for (const item of items) {
        const itemPath = join(fullPath, item.name);
        if (item.isDirectory()) {
          totalSize += this.getDirectorySize(itemPath);
        } else if (item.isFile()) {
          totalSize += statSync(itemPath).size;
        }
      }
    } catch (error) {
      logger.warn({ dirPath, error }, "Failed to calculate directory size");
    }

    return totalSize;
  }

  /**
   * Get current storage statistics (real-time calculation)
   */
  async getCurrentStorageStats(): Promise<CurrentStorageStats> {
    // Get video storage from database
    const videoStatsQuery = sql`
      SELECT
        COALESCE(SUM(file_size_bytes), 0) as total_size,
        COUNT(*) as total_count
      FROM videos
    `;

    const videoStatsRows = await db.execute(videoStatsQuery);
    const videoStatsRaw = videoStatsRows[0] as {
      total_size: string | number;
      total_count: string | number;
    };

    if (!videoStatsRaw) {
      throw new Error("Failed to get video stats");
    }

    const videoStats = {
      total_size: Number(videoStatsRaw.total_size),
      total_count: Number(videoStatsRaw.total_count),
    };

    // Get per-directory breakdown
    const directoryBreakdownQuery = sql`
      SELECT
        wd.id as directory_id,
        wd.path,
        COALESCE(SUM(v.file_size_bytes), 0) as size_bytes,
        COUNT(v.id) as video_count
      FROM watched_directories wd
      LEFT JOIN videos v ON v.directory_id = wd.id
      GROUP BY wd.id, wd.path
      ORDER BY size_bytes DESC
    `;

    const directoryBreakdownRaw = (await db.execute(
      directoryBreakdownQuery,
    )) as unknown as Array<{
      directory_id: string | number;
      path: string;
      size_bytes: string | number;
      video_count: string | number;
    }>;

    const directoryBreakdown: DirectoryStorageInfo[] =
      directoryBreakdownRaw.map((row) => ({
        directory_id: Number(row.directory_id),
        path: row.path,
        size_bytes: Number(row.size_bytes),
        video_count: Number(row.video_count),
      }));

    // Get managed directory sizes
    const thumbnailsSize = this.getDirectorySize(env.THUMBNAILS_DIR);
    const storyboardsSize = this.getDirectorySize(env.STORYBOARDS_DIR);
    const profilePicturesSize = this.getDirectorySize(env.PROFILE_PICTURES_DIR);
    const convertedSize = this.getDirectorySize(env.CONVERTED_VIDEOS_DIR);

    // Note: PostgreSQL stores data in its own data directory managed by the server
    // We no longer track database file size since it's not a local SQLite file
    const databaseSize = 0;

    const totalManagedSize =
      thumbnailsSize + storyboardsSize + profilePicturesSize + convertedSize;

    return {
      total_video_size_bytes: videoStats.total_size,
      total_video_count: videoStats.total_count,
      thumbnails_size_bytes: thumbnailsSize,
      storyboards_size_bytes: storyboardsSize,
      profile_pictures_size_bytes: profilePicturesSize,
      converted_size_bytes: convertedSize,
      database_size_bytes: databaseSize,
      directory_breakdown: directoryBreakdown,
      total_managed_size_bytes: totalManagedSize,
    };
  }

  /**
   * Create a storage snapshot
   */
  async createStorageSnapshot(): Promise<StorageSnapshot> {
    const current = await this.getCurrentStorageStats();

    const result = await db
      .insert(statsStorageSnapshotsTable)
      .values({
        totalVideoSizeBytes: current.total_video_size_bytes,
        totalVideoCount: current.total_video_count,
        thumbnailsSizeBytes: current.thumbnails_size_bytes,
        storyboardsSizeBytes: current.storyboards_size_bytes,
        profilePicturesSizeBytes: current.profile_pictures_size_bytes,
        convertedSizeBytes: current.converted_size_bytes,
        databaseSizeBytes: current.database_size_bytes,
        directoryBreakdown: JSON.stringify(current.directory_breakdown),
      })
      .returning();

    if (!result || result.length === 0) {
      throw new Error("Failed to create storage snapshot");
    }

    logger.info(
      {
        snapshotId: result[0].id,
        totalVideoSize: current.total_video_size_bytes,
      },
      "Storage snapshot created",
    );

    return this.mapToApiFormat(result[0]);
  }

  /**
   * Get storage snapshot history
   */
  async getStorageHistory(
    days: number = 30,
    limit: number = 100,
  ): Promise<StorageSnapshot[]> {
    const query = sql`
      SELECT * FROM stats_storage_snapshots
      WHERE created_at >= NOW() - INTERVAL '1 day' * ${days}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;

    const rows = await db.execute(query);

    return (rows as any[]).map((row) => this.mapToApiFormat(row));
  }

  /**
   * Get latest storage snapshot
   */
  async getLatestStorageSnapshot(): Promise<StorageSnapshot | null> {
    const query = sql`
      SELECT * FROM stats_storage_snapshots
      ORDER BY created_at DESC
      LIMIT 1
    `;

    const rows = await db.execute(query);

    if (!rows || rows.length === 0) {
      return null;
    }

    return this.mapToApiFormat(rows[0]);
  }

  /**
   * Map Drizzle result to API format
   */
  private mapToApiFormat(row: any): StorageSnapshot {
    // Helper to convert date to ISO string
    const toISOString = (val: unknown): string => {
      if (val instanceof Date) return val.toISOString();
      if (typeof val === "string") return val;
      return new Date().toISOString();
    };

    // Parse directory breakdown JSON if it's a string
    let directoryBreakdown = null;
    const rawBreakdown = row.directory_breakdown ?? row.directoryBreakdown;
    if (rawBreakdown) {
      const parsed =
        typeof rawBreakdown === "string"
          ? JSON.parse(rawBreakdown)
          : rawBreakdown;
      directoryBreakdown = Array.isArray(parsed)
        ? parsed.map((item: any) => ({
            directory_id: Number(item.directory_id),
            path: item.path,
            size_bytes: Number(item.size_bytes),
            video_count: Number(item.video_count),
          }))
        : null;
    }

    return {
      id: Number(row.id),
      total_video_size_bytes: Number(
        row.total_video_size_bytes ?? row.totalVideoSizeBytes ?? 0,
      ),
      total_video_count: Number(
        row.total_video_count ?? row.totalVideoCount ?? 0,
      ),
      thumbnails_size_bytes: Number(
        row.thumbnails_size_bytes ?? row.thumbnailsSizeBytes ?? 0,
      ),
      storyboards_size_bytes: Number(
        row.storyboards_size_bytes ?? row.storyboardsSizeBytes ?? 0,
      ),
      profile_pictures_size_bytes: Number(
        row.profile_pictures_size_bytes ?? row.profilePicturesSizeBytes ?? 0,
      ),
      converted_size_bytes: Number(
        row.converted_size_bytes ?? row.convertedSizeBytes ?? 0,
      ),
      database_size_bytes: Number(
        row.database_size_bytes ?? row.databaseSizeBytes ?? 0,
      ),
      directory_breakdown: directoryBreakdown,
      created_at: toISOString(row.created_at ?? row.createdAt),
    };
  }
}

export const storageStatsService = new StorageStatsService();
