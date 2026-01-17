import { sql } from "drizzle-orm";
import { db } from "@/config/drizzle";
import { statsLibrarySnapshotsTable } from "@/database/schema";
import { logger } from "@/utils/logger";
import type {
  CurrentLibraryStats,
  ResolutionBreakdown,
  CodecBreakdown,
  LibrarySnapshot,
} from "./stats.types";

/**
 * Library statistics service
 * Handles video metadata and library composition stats
 */
export class LibraryStatsService {
  /**
   * Get current library statistics
   */
  async getCurrentLibraryStats(): Promise<CurrentLibraryStats> {
    // Basic counts
    const countsQuery = sql`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN is_available = true THEN 1 ELSE 0 END) as available,
        SUM(CASE WHEN is_available = false THEN 1 ELSE 0 END) as unavailable,
        COALESCE(SUM(file_size_bytes), 0) as total_size,
        COALESCE(AVG(file_size_bytes), 0) as avg_size,
        COALESCE(SUM(duration_seconds), 0) as total_duration,
        COALESCE(AVG(duration_seconds), 0) as avg_duration
      FROM videos
    `;

    const countsRows = await db.execute(countsQuery);
    const countsRaw = countsRows[0] as {
      total: string | number;
      available: string | number;
      unavailable: string | number;
      total_size: string | number;
      avg_size: string | number;
      total_duration: string | number;
      avg_duration: string | number;
    };

    if (!countsRaw) {
      throw new Error("Failed to get library stats");
    }

    const counts = {
      total: Number(countsRaw.total),
      available: Number(countsRaw.available),
      unavailable: Number(countsRaw.unavailable),
      total_size: Number(countsRaw.total_size),
      avg_size: Number(countsRaw.avg_size),
      total_duration: Number(countsRaw.total_duration),
      avg_duration: Number(countsRaw.avg_duration),
    };

    // Resolution breakdown
    const resolutionsQuery = sql`
      SELECT
        CASE
          WHEN height >= 2160 THEN '4K'
          WHEN height >= 1440 THEN '1440p'
          WHEN height >= 1080 THEN '1080p'
          WHEN height >= 720 THEN '720p'
          WHEN height >= 480 THEN '480p'
          WHEN height IS NULL THEN 'Unknown'
          ELSE 'Other'
        END as resolution,
        COUNT(*) as count
      FROM videos
      GROUP BY resolution
      ORDER BY count DESC
    `;

    const resolutions = (await db.execute(resolutionsQuery)) as {
      resolution: string;
      count: string | number;
    }[];

    const resolutionBreakdown: ResolutionBreakdown[] = resolutions.map((r) => ({
      resolution: r.resolution,
      count: Number(r.count),
      percentage:
        counts.total > 0
          ? Math.round((Number(r.count) / counts.total) * 100)
          : 0,
    }));

    // Codec breakdown
    const codecsQuery = sql`
      SELECT
        COALESCE(codec, 'Unknown') as codec,
        COUNT(*) as count
      FROM videos
      GROUP BY codec
      ORDER BY count DESC
    `;

    const codecs = (await db.execute(codecsQuery)) as {
      codec: string;
      count: string | number;
    }[];

    const codecBreakdown: CodecBreakdown[] = codecs.map((c) => ({
      codec: c.codec,
      count: Number(c.count),
      percentage:
        counts.total > 0
          ? Math.round((Number(c.count) / counts.total) * 100)
          : 0,
    }));

    return {
      total_video_count: counts.total,
      available_video_count: counts.available,
      unavailable_video_count: counts.unavailable,
      total_size_bytes: counts.total_size,
      average_size_bytes: Math.round(counts.avg_size),
      total_duration_seconds: counts.total_duration,
      average_duration_seconds: Math.round(counts.avg_duration),
      resolution_breakdown: resolutionBreakdown,
      codec_breakdown: codecBreakdown,
    };
  }

  /**
   * Create a library snapshot
   */
  async createLibrarySnapshot(): Promise<LibrarySnapshot> {
    const current = await this.getCurrentLibraryStats();

    const result = await db
      .insert(statsLibrarySnapshotsTable)
      .values({
        totalVideoCount: current.total_video_count,
        availableVideoCount: current.available_video_count,
        unavailableVideoCount: current.unavailable_video_count,
        totalSizeBytes: current.total_size_bytes,
        averageSizeBytes: current.average_size_bytes,
        totalDurationSeconds: current.total_duration_seconds,
        averageDurationSeconds: current.average_duration_seconds,
        resolutionBreakdown: JSON.stringify(current.resolution_breakdown),
        codecBreakdown: JSON.stringify(current.codec_breakdown),
      })
      .returning();

    if (!result || result.length === 0) {
      throw new Error("Failed to create library snapshot");
    }

    logger.info(
      { snapshotId: result[0].id, videoCount: current.total_video_count },
      "Library snapshot created",
    );

    return this.mapToApiFormat(result[0]);
  }

  /**
   * Get library snapshot history
   */
  async getLibraryHistory(
    days: number = 30,
    limit: number = 100,
  ): Promise<LibrarySnapshot[]> {
    const query = sql`
      SELECT * FROM stats_library_snapshots
      WHERE created_at >= NOW() - INTERVAL '1 day' * ${days}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;

    const rows = await db.execute(query);

    return (rows as any[]).map((row) => this.mapToApiFormat(row));
  }

  /**
   * Get latest library snapshot
   */
  async getLatestLibrarySnapshot(): Promise<LibrarySnapshot | null> {
    const query = sql`
      SELECT * FROM stats_library_snapshots
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
  private mapToApiFormat(row: any): LibrarySnapshot {
    // Helper to convert date to ISO string
    const toISOString = (val: unknown): string => {
      if (val instanceof Date) return val.toISOString();
      if (typeof val === "string") return val;
      return new Date().toISOString();
    };

    // Parse JSON fields and ensure numbers
    const parseBreakdown = (rawData: unknown): any[] | null => {
      if (!rawData) return null;
      const parsed =
        typeof rawData === "string" ? JSON.parse(rawData) : rawData;
      return Array.isArray(parsed)
        ? parsed.map((item: any) => ({
            ...item,
            count: Number(item.count),
            percentage: Number(item.percentage),
          }))
        : null;
    };

    return {
      id: Number(row.id),
      total_video_count: Number(
        row.total_video_count ?? row.totalVideoCount ?? 0,
      ),
      available_video_count: Number(
        row.available_video_count ?? row.availableVideoCount ?? 0,
      ),
      unavailable_video_count: Number(
        row.unavailable_video_count ?? row.unavailableVideoCount ?? 0,
      ),
      total_size_bytes: Number(row.total_size_bytes ?? row.totalSizeBytes ?? 0),
      average_size_bytes: Number(
        row.average_size_bytes ?? row.averageSizeBytes ?? 0,
      ),
      total_duration_seconds: Number(
        row.total_duration_seconds ?? row.totalDurationSeconds ?? 0,
      ),
      average_duration_seconds: Number(
        row.average_duration_seconds ?? row.averageDurationSeconds ?? 0,
      ),
      resolution_breakdown: parseBreakdown(
        row.resolution_breakdown ?? row.resolutionBreakdown,
      ),
      codec_breakdown: parseBreakdown(
        row.codec_breakdown ?? row.codecBreakdown,
      ),
      created_at: toISOString(row.created_at ?? row.createdAt),
    };
  }
}

export const libraryStatsService = new LibraryStatsService();
