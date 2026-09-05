import { snapshotHistoryQuery, snapshotDateToISOString } from "./stats.snapshots";
import { sql } from "drizzle-orm";
import { db } from "@/config/drizzle";
import { statsUsageSnapshotsTable } from "@/database/schema";
import { logger } from "@/utils/logger";
import type {
  CurrentUsageStats,
  TopWatched,
  ActivityByHour,
  UsageSnapshot,
} from "./stats.types";

/**
 * Usage statistics service
 * Handles watch/play behavior and user activity stats
 */
export class UsageStatsService {
  /**
   * Get current usage statistics
   */
  async getCurrentUsageStats(): Promise<CurrentUsageStats> {
    // Aggregate watch stats
    const watchStatsQuery = sql`
      SELECT
        COALESCE(SUM(total_watch_seconds), 0) as total_watch,
        COALESCE(SUM(play_count), 0) as total_plays,
        COUNT(DISTINCT video_id) as unique_watched
      FROM video_stats
      WHERE play_count > 0
    `;

    // Videos never watched
    const neverWatchedQuery = sql`
      SELECT COUNT(*) as count FROM videos
      WHERE id NOT IN (SELECT video_id FROM video_stats WHERE play_count > 0)
    `;

    // Calculate average completion rate
    const completionDataQuery = sql`
      SELECT
        AVG(CASE
          WHEN v.duration_seconds > 0
          THEN LEAST(vs.total_watch_seconds / v.duration_seconds, 1.0) * 100
          ELSE NULL
        END) as avg_completion
      FROM video_stats vs
      JOIN videos v ON v.id = vs.video_id
      WHERE vs.total_watch_seconds > 0
    `;

    // Top watched videos
    const topWatchedQuery = sql`
      SELECT
        vs.video_id,
        COALESCE(v.title, v.file_name) as title,
        vs.play_count,
        vs.total_watch_seconds
      FROM video_stats vs
      JOIN videos v ON v.id = vs.video_id
      WHERE vs.play_count > 0
      ORDER BY vs.play_count DESC, vs.total_watch_seconds DESC
      LIMIT 10
    `;

    // Activity by hour (from last_watch_at timestamps)
    const hourlyActivityQuery = sql`
      SELECT
        TO_CHAR(last_watch_at, 'HH24') as hour,
        COUNT(*) as count
      FROM video_stats
      WHERE last_watch_at IS NOT NULL
      GROUP BY hour
      ORDER BY hour
    `;

    // Fetch all usage stats concurrently
    const [
      watchStatsRows,
      neverWatchedRows,
      completionDataRows,
      topWatchedRawResult,
      hourlyActivityResult,
    ] = await Promise.all([
      db.execute(watchStatsQuery),
      db.execute(neverWatchedQuery),
      db.execute(completionDataQuery),
      db.execute(topWatchedQuery),
      db.execute(hourlyActivityQuery),
    ]);

    const watchStatsRaw = watchStatsRows[0] as {
      total_watch: string | number;
      total_plays: string | number;
      unique_watched: string | number;
    };

    if (!watchStatsRaw) {
      throw new Error("Failed to get watch stats");
    }

    const watchStats = {
      total_watch: Number(watchStatsRaw.total_watch),
      total_plays: Number(watchStatsRaw.total_plays),
      unique_watched: Number(watchStatsRaw.unique_watched),
    };

    const neverWatched = neverWatchedRows[0] as { count: string | number };

    const completionData = completionDataRows[0] as {
      avg_completion: number | null;
    };

    const topWatchedRaw = topWatchedRawResult as unknown as Array<{
      video_id: string | number;
      title: string;
      play_count: string | number;
      total_watch_seconds: string | number;
    }>;

    const topWatched: TopWatched[] = topWatchedRaw.map((item) => ({
      video_id: Number(item.video_id),
      title: item.title,
      play_count: Number(item.play_count),
      total_watch_seconds: Number(item.total_watch_seconds),
    }));

    const hourlyActivity = hourlyActivityResult as unknown as {
      hour: string;
      count: string | number;
    }[];

    const activityByHour: ActivityByHour = {};
    for (let i = 0; i < 24; i++) {
      activityByHour[i.toString().padStart(2, "0")] = 0;
    }
    for (const row of hourlyActivity) {
      if (row.hour) {
        activityByHour[row.hour] = Number(row.count);
      }
    }

    return {
      total_watch_time_seconds: watchStats.total_watch,
      total_play_count: watchStats.total_plays,
      unique_videos_watched: watchStats.unique_watched,
      videos_never_watched: Number(neverWatched?.count ?? 0),
      average_completion_rate: completionData?.avg_completion
        ? Math.round(completionData.avg_completion * 100) / 100
        : null,
      top_watched: topWatched,
      activity_by_hour: activityByHour,
    };
  }

  /**
   * Create a usage snapshot
   */
  async createUsageSnapshot(): Promise<UsageSnapshot> {
    const current = await this.getCurrentUsageStats();

    const result = await db
      .insert(statsUsageSnapshotsTable)
      .values({
        totalWatchTimeSeconds: current.total_watch_time_seconds,
        totalPlayCount: current.total_play_count,
        uniqueVideosWatched: current.unique_videos_watched,
        videosNeverWatched: current.videos_never_watched,
        averageCompletionRate: current.average_completion_rate,
        topWatched: JSON.stringify(current.top_watched),
        activityByHour: JSON.stringify(current.activity_by_hour),
      })
      .returning();

    if (!result || result.length === 0) {
      throw new Error("Failed to create usage snapshot");
    }

    logger.info(
      { snapshotId: result[0].id, totalPlays: current.total_play_count },
      "Usage snapshot created",
    );

    return this.mapToApiFormat(result[0]);
  }

  /**
   * Get usage snapshot history
   */
  async getUsageHistory(
    days: number = 30,
    limit: number = 100,
  ): Promise<UsageSnapshot[]> {
    const query = snapshotHistoryQuery("stats_usage_snapshots", days, limit);

    const rows = await db.execute(query);

    return rows.map((row) => this.mapToApiFormat(row));
  }

  /**
   * Get latest usage snapshot
   */
  async getLatestUsageSnapshot(): Promise<UsageSnapshot | null> {
    const query = sql`
      SELECT * FROM stats_usage_snapshots
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
  private mapToApiFormat(row: any): UsageSnapshot {
    // Parse top watched JSON and ensure numbers
    const parseTopWatched = (rawData: unknown): TopWatched[] | null => {
      if (!rawData) return null;
      const parsed =
        typeof rawData === "string" ? JSON.parse(rawData) : rawData;
      return Array.isArray(parsed)
        ? parsed.map((item: any) => ({
            video_id: Number(item.video_id),
            title: item.title,
            play_count: Number(item.play_count),
            total_watch_seconds: Number(item.total_watch_seconds),
          }))
        : null;
    };

    // Parse activity by hour JSON and ensure numbers
    const parseActivityByHour = (rawData: unknown): ActivityByHour | null => {
      if (!rawData) return null;
      const parsed =
        typeof rawData === "string" ? JSON.parse(rawData) : rawData;
      if (typeof parsed !== "object" || parsed === null) return null;
      const result: ActivityByHour = {};
      for (const [key, value] of Object.entries(parsed)) {
        result[key] = Number(value);
      }
      return result;
    };

    return {
      id: Number(row.id),
      total_watch_time_seconds: Number(
        row.total_watch_time_seconds ?? row.totalWatchTimeSeconds ?? 0,
      ),
      total_play_count: Number(row.total_play_count ?? row.totalPlayCount ?? 0),
      unique_videos_watched: Number(
        row.unique_videos_watched ?? row.uniqueVideosWatched ?? 0,
      ),
      videos_never_watched: Number(
        row.videos_never_watched ?? row.videosNeverWatched ?? 0,
      ),
      average_completion_rate:
        row.average_completion_rate ?? row.averageCompletionRate ?? null,
      top_watched: parseTopWatched(row.top_watched ?? row.topWatched),
      activity_by_hour: parseActivityByHour(
        row.activity_by_hour ?? row.activityByHour,
      ),
      created_at: snapshotDateToISOString(row.created_at ?? row.createdAt),
    };
  }
}

export const usageStatsService = new UsageStatsService();
