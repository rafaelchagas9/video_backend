import { snapshotHistoryQuery, snapshotDateToISOString } from "./stats.snapshots";
import { readdir, stat as statAsync } from "fs/promises";
import { resolve, join } from "path";
import { sql } from "drizzle-orm";
import { db } from "@/config/drizzle";
import { statsStorageSnapshotsTable } from "@/database/schema";
import { env } from "@/config/env";
import { logger } from "@/utils/logger";
import type {
  CurrentStorageStats,
  DirectoryStorageInfo,
  StorageAssetInfo,
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
  private async getDirectorySize(dirPath: string, excludedRoots = new Set<string>()): Promise<number> {
    const fullPath = resolve(process.cwd(), dirPath);
    let totalSize = 0;
    const pending = [fullPath];

    while (pending.length) {
      const directory = pending.pop()!;
      let items;
      try {
        items = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" && directory === fullPath) return 0;
        throw error;
      }
      const files: string[] = [];
      for (const item of items) {
        const path = join(directory, item.name);
        if (excludedRoots.has(path)) continue;
        if (item.isDirectory()) pending.push(path);
        else if (item.isFile()) files.push(path);
      }
      // The library can contain tens of thousands of derivatives. Bound stat
      // concurrency so a stats request does not exhaust file descriptors.
      for (let index = 0; index < files.length; index += 64) {
        const sizes = await Promise.all(files.slice(index, index + 64).map(async (path) => {
          try {
            return (await statAsync(path)).size;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
            throw error;
          }
        }));
        totalSize += sizes.reduce((sum, size) => sum + size, 0);
      }
    }

    return totalSize;
  }

  /** Measure app-owned files without reading video or image contents. */
  async getAssetBreakdown(): Promise<StorageAssetInfo[]> {
    // Count actual files, including derivatives and caches that have no DB row.
    // Gallery images and profile images share PROFILE_PICTURES_DIR.
    const assetDirectories = [
      { key: "thumbnails", label: "Thumbnails", path: env.THUMBNAILS_DIR },
      { key: "storyboards", label: "Storyboards", path: env.STORYBOARDS_DIR },
      { key: "profiles_gallery", label: "Profiles & gallery", path: env.PROFILE_PICTURES_DIR },
      { key: "faces", label: "Face crops", path: env.FACES_DIR },
      { key: "face_thumbnails", label: "Face thumbnails", path: env.CREATOR_FACE_THUMBNAILS_DIR },
      { key: "artwork", label: "Artwork", path: env.ARTWORK_DIR },
      { key: "previews", label: "Video previews", path: env.PREVIEWS_DIR },
      { key: "converted", label: "Converted files", path: env.CONVERTED_VIDEOS_DIR },
      { key: "copy_cache", label: "Copy detection cache", path: env.COPY_DETECTION_CACHE_DIR },
      { key: "perceptual_cache", label: "Perceptual index cache", path: "./data/perceptual-duplicates-cache" },
      { key: "cast_transcodes", label: "Cast transcodes", path: env.CAST_TRANSCODE_DIR },
      { key: "backups", label: "Database backups", path: "./data/backups" },
    ];
    const knownPaths = assetDirectories.map(({ path }) => resolve(process.cwd(), path));
    const sizes = await Promise.all(knownPaths.map((path, index) => {
      if (knownPaths.indexOf(path) !== index) return Promise.resolve(0);
      return this.getDirectorySize(path, new Set(knownPaths.filter((other) => other !== path)));
    }));
    const assetBreakdown = assetDirectories.map(({ key, label }, index) => ({
      key,
      label,
      size_bytes: sizes[index],
    }));

    // Keep newly introduced data/ directories visible without double counting
    // the named roots, even when a configured root is nested under another.
    const dataRoot = resolve(process.cwd(), "data");
    const otherDataSize = await this.getDirectorySize(dataRoot, new Set(knownPaths));
    assetBreakdown.push({ key: "other_data", label: "Other app data", size_bytes: otherDataSize });

    return assetBreakdown;
  }

  /**
   * Get current storage statistics (real-time calculation)
   */
  async getCurrentStorageStats(): Promise<CurrentStorageStats> {
    // Video bytes are catalog metadata; managed asset bytes are measured files.
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

    const assetBreakdown = await this.getAssetBreakdown();
    const sizeFor = (key: string) => assetBreakdown.find((item) => item.key === key)?.size_bytes ?? 0;
    const thumbnailsSize = sizeFor("thumbnails");
    const storyboardsSize = sizeFor("storyboards");
    const profilePicturesSize = sizeFor("profiles_gallery");
    const facesSize = sizeFor("faces");
    const convertedSize = sizeFor("converted");

    // Note: PostgreSQL stores data in its own data directory managed by the server
    // We no longer track database file size since it's not a local SQLite file
    const databaseSize = 0;

    const totalManagedSize = assetBreakdown.reduce((sum, item) => sum + item.size_bytes, 0);

    return {
      total_video_size_bytes: videoStats.total_size,
      total_video_count: videoStats.total_count,
      thumbnails_size_bytes: thumbnailsSize,
      storyboards_size_bytes: storyboardsSize,
      profile_pictures_size_bytes: profilePicturesSize,
      converted_size_bytes: convertedSize,
      faces_size_bytes: facesSize,
      database_size_bytes: databaseSize,
      directory_breakdown: directoryBreakdown,
      asset_breakdown: assetBreakdown,
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
        facesSizeBytes: current.faces_size_bytes,
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
    const query = snapshotHistoryQuery("stats_storage_snapshots", days, limit);

    const rows = await db.execute(query);

    return rows.map((row) => this.mapToApiFormat(row));
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
      faces_size_bytes: Number(
        row.faces_size_bytes ?? row.facesSizeBytes ?? 0,
      ),
      database_size_bytes: Number(
        row.database_size_bytes ?? row.databaseSizeBytes ?? 0,
      ),
      directory_breakdown: directoryBreakdown,
      created_at: snapshotDateToISOString(row.created_at ?? row.createdAt),
    };
  }
}

export const storageStatsService = new StorageStatsService();
