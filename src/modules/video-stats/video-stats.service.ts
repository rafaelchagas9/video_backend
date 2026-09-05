import { db } from "@/config/drizzle";
import { eq, and, sql, desc, isNotNull, inArray } from "drizzle-orm";
import { videoStatsTable, videosTable, thumbnailsTable } from "@/database/schema";
import { NotFoundError } from "@/utils/errors";
import { API_PREFIX } from "@/config/constants";
import type {
  AggregateVideoStats,
  VideoStats,
  WatchHistoryEntry,
  WatchHistoryQuery,
  WatchHistoryResult,
  WatchHistoryInclude,
  WatchUpdateInput,
} from "./video-stats.types";
import { settingsService } from "@/modules/settings/settings.service";
import { env } from "@/config/env";
import { artworkService } from "@/modules/artwork/artwork.service";
import { creatorsRelationshipsService } from "@/modules/creators/creators.relationships.service";
import { studiosRelationshipsService } from "@/modules/studios/studios.relationships.service";
import { tagsService } from "@/modules/tags/tags.service";

export interface VideoStatsSummary {
  play_count: number;
  last_played_at: string | null;
}

interface RecordWatchResult {
  stats: VideoStats;
  aggregate: AggregateVideoStats;
  play_count_incremented: boolean;
}

export class VideoStatsService {
  private async getDemoVideo(videoId: number) {
    const { demoRepository } = await import("@/database/demo/repository");
    return demoRepository.getVideoById(videoId);
  }

  private mapDemoStats(userId: number, video: any): VideoStats {
    const now = new Date().toISOString();
    const stats = video.stats ?? {};
    const lastPositionSeconds = Number(stats.lastPositionSeconds ?? 0);
    const lastWatchAt =
      stats.lastWatchAt ??
      (lastPositionSeconds > 0
        ? new Date(Date.now() - video.id * 60_000).toISOString()
        : null);

    return {
      user_id: userId,
      video_id: video.id,
      play_count: Number(stats.playCount ?? 0),
      total_watch_seconds: Number(stats.totalWatchSeconds ?? 0),
      session_watch_seconds: Number(stats.sessionWatchSeconds ?? 0),
      session_play_counted: Number(stats.sessionPlayCounted ?? 0),
      last_position_seconds:
        lastPositionSeconds > 0 ? lastPositionSeconds : null,
      last_played_at: stats.lastPlayedAt ?? lastWatchAt,
      last_watch_at: lastWatchAt,
      created_at: stats.createdAt ?? now,
      updated_at: stats.updatedAt ?? now,
    };
  }

  private mapDemoAggregate(stats: VideoStats): AggregateVideoStats {
    return {
      video_id: stats.video_id,
      total_play_count: stats.play_count,
      total_watch_seconds: stats.total_watch_seconds,
      last_played_at: stats.last_played_at,
    };
  }

  async getSummariesForVideos(
    userId: number,
    videoIds: number[],
  ): Promise<Map<number, VideoStatsSummary>> {
    const summaries = new Map<number, VideoStatsSummary>();
    for (const videoId of videoIds) {
      summaries.set(videoId, { play_count: 0, last_played_at: null });
    }
    if (videoIds.length === 0) return summaries;

    if (env.DEMO_MODE) {
      for (const videoId of videoIds) {
        const stats = this.mapDemoStats(userId, await this.getDemoVideo(videoId));
        summaries.set(videoId, {
          play_count: stats.play_count,
          last_played_at: stats.last_played_at,
        });
      }
      return summaries;
    }

    const rows = await db
      .select({
        videoId: videoStatsTable.videoId,
        playCount: videoStatsTable.playCount,
        lastPlayedAt: videoStatsTable.lastPlayedAt,
      })
      .from(videoStatsTable)
      .where(
        and(
          eq(videoStatsTable.userId, userId),
          inArray(videoStatsTable.videoId, videoIds),
        ),
      );

    for (const row of rows) {
      summaries.set(row.videoId, {
        play_count: row.playCount,
        last_played_at:
          row.lastPlayedAt instanceof Date
            ? row.lastPlayedAt.toISOString()
            : row.lastPlayedAt,
      });
    }
    return summaries;
  }

  private async attachHistoryIncludes(
    entries: WatchHistoryEntry[],
    include: WatchHistoryInclude[],
  ): Promise<WatchHistoryEntry[]> {
    if (entries.length === 0 || include.length === 0) return entries;
    const videoIds = entries.map((entry) => entry.video.id);
    const [artwork, creators, tags, studios] = await Promise.all([
      include.includes("artwork")
        ? artworkService.getSummariesByVideoIds(videoIds)
        : Promise.resolve(new Map()),
      include.includes("creators")
        ? creatorsRelationshipsService.getCreatorsForVideos(videoIds)
        : Promise.resolve(new Map()),
      include.includes("tags")
        ? tagsService.getTagsForVideos(videoIds)
        : Promise.resolve(new Map()),
      include.includes("studios")
        ? studiosRelationshipsService.getStudiosForVideos(videoIds)
        : Promise.resolve(new Map()),
    ]);

    return entries.map((entry) => ({
      ...entry,
      video: {
        ...entry.video,
        ...(include.includes("artwork")
          ? { artwork: artwork.get(entry.video.id) ?? null }
          : {}),
        ...(include.includes("creators")
          ? { creators: creators.get(entry.video.id) ?? [] }
          : {}),
        ...(include.includes("tags")
          ? { tags: tags.get(entry.video.id) ?? [] }
          : {}),
        ...(include.includes("studios")
          ? { studios: studios.get(entry.video.id) ?? [] }
          : {}),
      },
    }));
  }

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
    if (env.DEMO_MODE) {
      const video = await this.getDemoVideo(videoId);
      const now = new Date().toISOString();
      const stats = video.stats ?? {};
      stats.totalWatchSeconds =
        Number(stats.totalWatchSeconds ?? 0) + input.watched_seconds;
      stats.sessionWatchSeconds =
        Number(stats.sessionWatchSeconds ?? 0) + input.watched_seconds;
      if (input.last_position_seconds !== undefined) {
        stats.lastPositionSeconds = input.last_position_seconds;
      }
      stats.lastWatchAt = now;
      stats.updatedAt = now;
      video.stats = stats;

      const mappedStats = this.mapDemoStats(userId, video);
      return {
        stats: mappedStats,
        aggregate: this.mapDemoAggregate(mappedStats),
        play_count_incremented: false,
      };
    }

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
    if (env.DEMO_MODE) {
      const stats = this.mapDemoStats(
        userId,
        await this.getDemoVideo(videoId),
      );
      return {
        stats,
        aggregate: this.mapDemoAggregate(stats),
      };
    }

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

  async getHistory(
    userId: number,
    query: WatchHistoryQuery,
  ): Promise<WatchHistoryResult> {
    const page = query.page;
    const limit = query.limit;
    const offset = (page - 1) * limit;

    // Demo mode is an isolation boundary: never join real watch or video rows.
    if (env.DEMO_MODE) {
      const { demoRepository } = await import("@/database/demo/repository");
      const videos = demoRepository.getVideos({ limit: 100 }).data;
      const entries = videos
        .map((video: any): WatchHistoryEntry | null => {
          const stats = this.mapDemoStats(userId, video);
          if (!stats.last_watch_at) {
            return null;
          }
          return {
            video: {
              id: video.id,
              file_name: video.file_name,
              title: video.title,
              duration_seconds: video.duration_seconds,
              thumbnail_id: video.thumbnail_id,
              thumbnail_url: video.thumbnail_url,
            },
            play_count: stats.play_count,
            total_watch_seconds: stats.total_watch_seconds,
            last_position_seconds: stats.last_position_seconds,
            last_played_at: stats.last_played_at,
            last_watch_at: stats.last_watch_at,
          };
        })
        .filter((entry: WatchHistoryEntry | null): entry is WatchHistoryEntry =>
          entry !== null,
        )
        .sort((a: WatchHistoryEntry, b: WatchHistoryEntry) =>
          b.last_watch_at.localeCompare(a.last_watch_at),
        );
      const total = entries.length;

      return {
        data: await this.attachHistoryIncludes(
          entries.slice(offset, offset + limit),
          query.include,
        ),
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      };
    }

    const whereClause = and(
      eq(videoStatsTable.userId, userId),
      isNotNull(videoStatsTable.lastWatchAt),
    );

    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(videoStatsTable)
      .where(whereClause);

    const total = Number(countResult[0]?.count ?? 0);

    const rows = await db
      .select({
        playCount: videoStatsTable.playCount,
        totalWatchSeconds: videoStatsTable.totalWatchSeconds,
        lastPositionSeconds: videoStatsTable.lastPositionSeconds,
        lastPlayedAt: videoStatsTable.lastPlayedAt,
        lastWatchAt: videoStatsTable.lastWatchAt,
        videoId: videosTable.id,
        fileName: videosTable.fileName,
        title: videosTable.title,
        durationSeconds: videosTable.durationSeconds,
        thumbnailId: thumbnailsTable.id,
      })
      .from(videoStatsTable)
      .innerJoin(videosTable, eq(videoStatsTable.videoId, videosTable.id))
      .leftJoin(thumbnailsTable, eq(videosTable.id, thumbnailsTable.videoId))
      .where(whereClause)
      .orderBy(desc(videoStatsTable.lastWatchAt))
      .limit(limit)
      .offset(offset);

    const entries = rows.map((row): WatchHistoryEntry => ({
        video: {
          id: row.videoId,
          file_name: row.fileName,
          title: row.title,
          duration_seconds: row.durationSeconds,
          thumbnail_id: row.thumbnailId,
          thumbnail_url: row.thumbnailId
            ? `${API_PREFIX}/thumbnails/${row.thumbnailId}/image`
            : null,
        },
        play_count: row.playCount,
        total_watch_seconds: row.totalWatchSeconds,
        last_position_seconds: row.lastPositionSeconds,
        last_played_at:
          row.lastPlayedAt instanceof Date
            ? row.lastPlayedAt.toISOString()
            : row.lastPlayedAt,
        last_watch_at:
          row.lastWatchAt instanceof Date
            ? row.lastWatchAt.toISOString()
            : String(row.lastWatchAt),
      }));

    return {
      data: await this.attachHistoryIncludes(entries, query.include),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
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
