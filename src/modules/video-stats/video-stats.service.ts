import { getDatabase } from "@/config/database";
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
  private get db() {
    return getDatabase();
  }

  private getAggregateStats(videoId: number): AggregateVideoStats {
    const aggregate = this.db
      .prepare(
        `SELECT video_id,
                COALESCE(SUM(play_count), 0) as total_play_count,
                COALESCE(SUM(total_watch_seconds), 0) as total_watch_seconds,
                MAX(last_played_at) as last_played_at
         FROM video_stats
         WHERE video_id = ?
         GROUP BY video_id`,
      )
      .get(videoId) as AggregateVideoStats | undefined;

    return (
      aggregate ?? {
        video_id: videoId,
        total_play_count: 0,
        total_watch_seconds: 0,
        last_played_at: null,
      }
    );
  }

  async recordWatch(
    userId: number,
    videoId: number,
    input: WatchUpdateInput,
  ): Promise<RecordWatchResult> {
    const video = this.db
      .prepare("SELECT duration_seconds FROM videos WHERE id = ?")
      .get(videoId) as { duration_seconds: number | null } | undefined;

    if (!video) {
      throw new NotFoundError(`Video not found with id: ${videoId}`);
    }

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
      video.duration_seconds !== null &&
      video.duration_seconds <= shortVideoDurationSeconds
        ? shortVideoWatchSeconds
        : minWatchSeconds;

    const existing = this.db
      .prepare("SELECT * FROM video_stats WHERE user_id = ? AND video_id = ?")
      .get(userId, videoId) as VideoStats | undefined;

    const now = new Date();
    const nowIso = now.toISOString();

    let sessionWatchSeconds = existing?.session_watch_seconds ?? 0;
    let sessionPlayCounted = existing?.session_play_counted ? 1 : 0;

    if (existing?.last_watch_at) {
      const lastWatchAt = new Date(existing.last_watch_at);
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
      (existing?.total_watch_seconds ?? 0) + input.watched_seconds;
    const lastPositionSeconds =
      input.last_position_seconds !== undefined
        ? input.last_position_seconds
        : (existing?.last_position_seconds ?? null);

    let playCount = existing?.play_count ?? 0;
    let lastPlayedAt = existing?.last_played_at ?? null;
    let playCountIncremented = false;

    if (!sessionPlayCounted && sessionWatchSeconds >= thresholdSeconds) {
      playCount += 1;
      sessionPlayCounted = 1;
      lastPlayedAt = nowIso;
      playCountIncremented = true;
    }

    this.db
      .prepare(
        `INSERT INTO video_stats (
           user_id,
           video_id,
           play_count,
           total_watch_seconds,
           session_watch_seconds,
           session_play_counted,
           last_position_seconds,
           last_played_at,
           last_watch_at,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
         ON CONFLICT(user_id, video_id) DO UPDATE SET
           play_count = excluded.play_count,
           total_watch_seconds = excluded.total_watch_seconds,
           session_watch_seconds = excluded.session_watch_seconds,
           session_play_counted = excluded.session_play_counted,
           last_position_seconds = excluded.last_position_seconds,
           last_played_at = excluded.last_played_at,
           last_watch_at = excluded.last_watch_at,
           updated_at = datetime('now')`,
      )
      .run(
        userId,
        videoId,
        playCount,
        totalWatchSeconds,
        sessionWatchSeconds,
        sessionPlayCounted,
        lastPositionSeconds,
        lastPlayedAt,
        nowIso,
      );

    const stats = this.db
      .prepare("SELECT * FROM video_stats WHERE user_id = ? AND video_id = ?")
      .get(userId, videoId) as VideoStats;

    return {
      stats,
      aggregate: this.getAggregateStats(videoId),
      play_count_incremented: playCountIncremented,
    };
  }

  async getStats(
    userId: number,
    videoId: number,
  ): Promise<{ stats: VideoStats; aggregate: AggregateVideoStats }> {
    const video = this.db
      .prepare("SELECT 1 FROM videos WHERE id = ?")
      .get(videoId) as { 1: number } | undefined;

    if (!video) {
      throw new NotFoundError(`Video not found with id: ${videoId}`);
    }

    const stats = this.db
      .prepare("SELECT * FROM video_stats WHERE user_id = ? AND video_id = ?")
      .get(userId, videoId) as VideoStats | undefined;

    const statsRow: VideoStats = stats ?? {
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
      aggregate: this.getAggregateStats(videoId),
    };
  }
}

export const videoStatsService = new VideoStatsService();
