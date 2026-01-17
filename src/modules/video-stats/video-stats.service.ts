import { db } from "@/config/drizzle";
import { eq, and, sql } from "drizzle-orm";
import { videoStatsTable, videosTable } from "@/database/schema";
import { NotFoundError } from "@/utils/errors";
import type {
  AggregateVideoStats,
  VideoStats,
  WatchUpdateInput,
} from "./video-stats.types";
import { settingsService } from "@/modules/settings/settings.service";

interface RecordWatchResult {
  stats: VideoStats;
  aggregate: AggregateVideoStats;
  play_count_incremented: boolean;
}

export class VideoStatsService {
  private async getAggregateStats(
    videoId: number,
  ): Promise<AggregateVideoStats> {
    const aggregateResult = await db.execute(sql`
      SELECT video_id,
             COALESCE(SUM(play_count), 0) as total_play_count,
             COALESCE(SUM(total_watch_seconds), 0) as total_watch_seconds,
             MAX(last_played_at) as last_played_at
      FROM video_stats
      WHERE video_id = ${videoId}
      GROUP BY video_id
    `);

    const rows = aggregateResult as any[];
    if (rows.length === 0) {
      return {
        video_id: videoId,
        total_play_count: 0,
        total_watch_seconds: 0,
        last_played_at: null,
      };
    }

    const aggregate = rows[0];
    return {
      video_id: aggregate.video_id,
      total_play_count: Number(aggregate.total_play_count),
      total_watch_seconds: Number(aggregate.total_watch_seconds),
      last_played_at:
        aggregate.last_played_at instanceof Date
          ? aggregate.last_played_at.toISOString()
          : aggregate.last_played_at,
    };
  }

  async recordWatch(
    userId: number,
    videoId: number,
    input: WatchUpdateInput,
  ): Promise<RecordWatchResult> {
    const videos = await db
      .select({ durationSeconds: videosTable.durationSeconds })
      .from(videosTable)
      .where(eq(videosTable.id, videoId));

    if (videos.length === 0) {
      throw new NotFoundError(`Video not found with id: ${videoId}`);
    }

    const video = videos[0];

    const minWatchSeconds =
      await settingsService.getNumber("min_watch_seconds");
    const shortVideoWatchSeconds = await settingsService.getNumber(
      "short_video_watch_seconds",
    );
    const shortVideoDurationSeconds = await settingsService.getNumber(
      "short_video_duration_seconds",
    );
    const sessionGapMinutes = await settingsService.getNumber(
      "watch_session_gap_minutes",
    );

    const thresholdSeconds =
      video.durationSeconds !== null &&
      video.durationSeconds <= shortVideoDurationSeconds
        ? shortVideoWatchSeconds
        : minWatchSeconds;

    const existingStats = await db
      .select()
      .from(videoStatsTable)
      .where(
        and(
          eq(videoStatsTable.userId, userId),
          eq(videoStatsTable.videoId, videoId),
        ),
      );

    const existing = existingStats.length > 0 ? existingStats[0] : undefined;

    const now = new Date();

    let sessionWatchSeconds = existing?.sessionWatchSeconds ?? 0;
    let sessionPlayCounted = existing?.sessionPlayCounted ? 1 : 0;

    if (existing?.lastWatchAt) {
      const lastWatchAt = new Date(existing.lastWatchAt);
      if (!Number.isNaN(lastWatchAt.getTime())) {
        const gapMs = sessionGapMinutes * 60 * 1000;
        if (gapMs > 0 && now.getTime() - lastWatchAt.getTime() > gapMs) {
          sessionWatchSeconds = 0;
          sessionPlayCounted = 0;
        }
      }
    }

    sessionWatchSeconds += input.watched_seconds;

    const totalWatchSeconds =
      (existing?.totalWatchSeconds ?? 0) + input.watched_seconds;
    const lastPositionSeconds =
      input.last_position_seconds !== undefined
        ? input.last_position_seconds
        : (existing?.lastPositionSeconds ?? null);

    let playCount = existing?.playCount ?? 0;
    let lastPlayedAt: Date | null = existing?.lastPlayedAt ?? null;
    let playCountIncremented = false;

    if (!sessionPlayCounted && sessionWatchSeconds >= thresholdSeconds) {
      playCount += 1;
      sessionPlayCounted = 1;
      lastPlayedAt = now;
      playCountIncremented = true;
    }

    await db
      .insert(videoStatsTable)
      .values({
        userId,
        videoId,
        playCount,
        totalWatchSeconds,
        sessionWatchSeconds,
        sessionPlayCounted: sessionPlayCounted === 1,
        lastPositionSeconds,
        lastPlayedAt,
        lastWatchAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [videoStatsTable.userId, videoStatsTable.videoId],
        set: {
          playCount,
          totalWatchSeconds,
          sessionWatchSeconds,
          sessionPlayCounted: sessionPlayCounted === 1,
          lastPositionSeconds,
          lastPlayedAt,
          lastWatchAt: now,
          updatedAt: now,
        },
      });

    const statsResults = await db
      .select()
      .from(videoStatsTable)
      .where(
        and(
          eq(videoStatsTable.userId, userId),
          eq(videoStatsTable.videoId, videoId),
        ),
      );

    const stats = this.mapToSnakeCase(statsResults[0]);

    return {
      stats,
      aggregate: await this.getAggregateStats(videoId),
      play_count_incremented: playCountIncremented,
    };
  }

  async getStats(
    userId: number,
    videoId: number,
  ): Promise<{ stats: VideoStats; aggregate: AggregateVideoStats }> {
    const videos = await db
      .select({ id: videosTable.id })
      .from(videosTable)
      .where(eq(videosTable.id, videoId));

    if (videos.length === 0) {
      throw new NotFoundError(`Video not found with id: ${videoId}`);
    }

    const statsResults = await db
      .select()
      .from(videoStatsTable)
      .where(
        and(
          eq(videoStatsTable.userId, userId),
          eq(videoStatsTable.videoId, videoId),
        ),
      );

    const statsRow: VideoStats =
      statsResults.length > 0
        ? this.mapToSnakeCase(statsResults[0])
        : {
            user_id: userId,
            video_id: videoId,
            play_count: 0,
            total_watch_seconds: 0,
            session_watch_seconds: 0,
            session_play_counted: 0,
            last_position_seconds: null,
            last_played_at: null,
            last_watch_at: null,
            created_at: new Date(0).toISOString(),
            updated_at: new Date(0).toISOString(),
          };

    return {
      stats: statsRow,
      aggregate: await this.getAggregateStats(videoId),
    };
  }

  private mapToSnakeCase(row: any): VideoStats {
    return {
      user_id: row.userId,
      video_id: row.videoId,
      play_count: row.playCount,
      total_watch_seconds: row.totalWatchSeconds,
      session_watch_seconds: row.sessionWatchSeconds,
      session_play_counted: row.sessionPlayCounted ? 1 : 0,
      last_position_seconds: row.lastPositionSeconds,
      last_played_at:
        row.lastPlayedAt instanceof Date
          ? row.lastPlayedAt.toISOString()
          : row.lastPlayedAt,
      last_watch_at:
        row.lastWatchAt instanceof Date
          ? row.lastWatchAt.toISOString()
          : row.lastWatchAt,
      created_at:
        row.createdAt instanceof Date
          ? row.createdAt.toISOString()
          : row.createdAt,
      updated_at:
        row.updatedAt instanceof Date
          ? row.updatedAt.toISOString()
          : row.updatedAt,
    };
  }
}

export const videoStatsService = new VideoStatsService();
