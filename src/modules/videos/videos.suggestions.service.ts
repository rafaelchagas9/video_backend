import { eq, sql, desc } from "drizzle-orm";
import { db } from "@/config/drizzle";
import {
  videosTable,
  videoStatsTable,
  thumbnailsTable,
} from "@/database/schema";
import { settingsService } from "@/modules/settings/settings.service";
import { API_PREFIX } from "@/config/constants";
import type { CompressionSuggestion } from "./videos.types";

/**
 * Service for generating video compression suggestions
 */
export class VideosSuggestionsService {
  /**
   * Get compression suggestions for videos
   */
  async getCompressionSuggestions(
    options: { limit?: number; offset?: number } = {},
  ): Promise<CompressionSuggestion[]> {
    const maxSuggestions = await settingsService.getNumber("max_suggestions");
    const downscaleInactiveDays = await settingsService.getNumber(
      "downscale_inactive_days",
    );
    const minWatchSeconds =
      await settingsService.getNumber("min_watch_seconds");

    const limit = Math.min(options.limit ?? 50, maxSuggestions || 200);
    const offset = options.offset ?? 0;
    const queryLimit = Math.min(limit * 3, maxSuggestions || 200);

    // Build complex query with LEFT JOINs to get stats and thumbnails
    const rows = await db
      .select({
        videoId: videosTable.id,
        fileName: videosTable.fileName,
        fileSizeBytes: videosTable.fileSizeBytes,
        width: videosTable.width,
        height: videosTable.height,
        codec: videosTable.codec,
        bitrate: videosTable.bitrate,
        fps: videosTable.fps,
        durationSeconds: videosTable.durationSeconds,
        totalPlayCount: sql<number>`COALESCE(SUM(${videoStatsTable.playCount}), 0)::int`,
        totalWatchSeconds: sql<number>`COALESCE(SUM(${videoStatsTable.totalWatchSeconds}), 0)`,
        lastPlayedAt: sql<Date | null>`MAX(${videoStatsTable.lastPlayedAt})`,
        thumbnailId: thumbnailsTable.id,
      })
      .from(videosTable)
      .leftJoin(thumbnailsTable, eq(videosTable.id, thumbnailsTable.videoId))
      .leftJoin(videoStatsTable, eq(videosTable.id, videoStatsTable.videoId))
      .where(eq(videosTable.isAvailable, true))
      .groupBy(videosTable.id, thumbnailsTable.id)
      .orderBy(desc(videosTable.fileSizeBytes))
      .limit(queryLimit)
      .offset(offset);

    const now = new Date();

    const suggestions = rows
      .map((row) => {
        const reasons = new Set<string>();
        let technicalScore = 0;
        let usageScore = 0;

        const codec = row.codec?.toLowerCase() ?? "";
        const codecCategory = codec.includes("av1")
          ? "av1"
          : codec.includes("hevc") || codec.includes("h265")
            ? "hevc"
            : codec.includes("h264") || codec.includes("avc")
              ? "h264"
              : "other";

        if (codecCategory !== "av1") {
          reasons.add("codec-inefficient");
          technicalScore +=
            codecCategory === "h264" ? 40 : codecCategory === "hevc" ? 20 : 30;
        }

        const fileSizeGb = row.fileSizeBytes / 1024 ** 3;
        if (fileSizeGb >= 20) {
          reasons.add("large-file");
          technicalScore += 30;
        } else if (fileSizeGb >= 10) {
          reasons.add("large-file");
          technicalScore += 20;
        } else if (fileSizeGb >= 5) {
          reasons.add("large-file");
          technicalScore += 12;
        }

        const bitrateKbps = row.bitrate ? row.bitrate / 1000 : null;
        if (bitrateKbps !== null) {
          if (bitrateKbps >= 20000) {
            reasons.add("high-bitrate");
            technicalScore += 15;
          } else if (bitrateKbps >= 12000) {
            reasons.add("high-bitrate");
            technicalScore += 8;
          }
        }

        if ((row.height ?? 0) >= 2160) {
          reasons.add("ultra-hd");
          technicalScore += 20;
        } else if ((row.height ?? 0) >= 1440) {
          reasons.add("high-resolution");
          technicalScore += 10;
        }

        if ((row.fps ?? 0) >= 60) {
          reasons.add("high-fps");
          technicalScore += 6;
        }

        if (row.totalPlayCount <= 1) {
          reasons.add("low-play-count");
          usageScore += 15;
        } else if (row.totalPlayCount <= 3) {
          reasons.add("low-play-count");
          usageScore += 8;
        }

        if (row.totalWatchSeconds < minWatchSeconds) {
          reasons.add("low-watch-time");
          usageScore += 8;
        }

        let daysSinceLastPlayed: number | null = null;
        if (row.lastPlayedAt) {
          const lastPlayedAt = new Date(row.lastPlayedAt);
          if (!Number.isNaN(lastPlayedAt.getTime())) {
            daysSinceLastPlayed =
              (now.getTime() - lastPlayedAt.getTime()) / (1000 * 60 * 60 * 24);
          }
        }

        if (daysSinceLastPlayed === null) {
          reasons.add("never-played");
          usageScore += 20;
        } else if (daysSinceLastPlayed >= downscaleInactiveDays) {
          reasons.add("stale-playback");
          usageScore += 12;
        }

        const recommendedActions: string[] = [];
        if (codecCategory !== "av1") {
          recommendedActions.push("reencode_av1");
        }

        const shouldDownscale =
          (row.height ?? 0) >= 2160 &&
          (daysSinceLastPlayed === null ||
            daysSinceLastPlayed >= downscaleInactiveDays);

        if (shouldDownscale) {
          recommendedActions.push("downscale_1080p");
        }

        return {
          video_id: row.videoId,
          file_name: row.fileName,
          file_size_bytes: row.fileSizeBytes,
          width: row.width,
          height: row.height,
          codec: row.codec,
          bitrate: row.bitrate,
          fps: row.fps,
          duration_seconds: row.durationSeconds,
          total_play_count: row.totalPlayCount,
          total_watch_seconds: row.totalWatchSeconds,
          last_played_at: row.lastPlayedAt
            ? row.lastPlayedAt instanceof Date
              ? row.lastPlayedAt.toISOString()
              : String(row.lastPlayedAt)
            : null,
          technical_score: technicalScore,
          usage_score: usageScore,
          recommended_actions: recommendedActions,
          reasons: Array.from(reasons),
          thumbnail_id: row.thumbnailId,
          thumbnail_url: row.thumbnailId
            ? `${API_PREFIX}/thumbnails/${row.thumbnailId}/image`
            : null,
        } as CompressionSuggestion;
      })
      .filter((suggestion) => suggestion.recommended_actions.length > 0)
      .sort((a, b) => {
        if (b.technical_score !== a.technical_score) {
          return b.technical_score - a.technical_score;
        }
        if (b.usage_score !== a.usage_score) {
          return b.usage_score - a.usage_score;
        }
        return b.file_size_bytes - a.file_size_bytes;
      })
      .slice(0, limit);

    return suggestions;
  }
}

export const videosSuggestionsService = new VideosSuggestionsService();
