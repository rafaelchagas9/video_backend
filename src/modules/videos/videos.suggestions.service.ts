import { eq, sql, and, not, exists } from "drizzle-orm";
import { db } from "@/config/drizzle";
import {
  videosTable,
  videoStatsTable,
  thumbnailsTable,
  favoritesTable,
  conversionJobsTable,
  conversionHistoryTable,
} from "@/database/schema";
import { CONVERSION_PRESETS } from "@/config/presets";
import { settingsService } from "@/modules/settings/settings.service";
import { API_PREFIX } from "@/config/constants";
import type {
  CompressionSuggestion,
  CompressionSuggestionsSummary,
} from "./videos.types";

/** Hardcoded conservative fallback ratios when no history exists */
const DEFAULT_RATIOS: Record<string, number> = {
  "1080p_av1:h264": 0.25,
  "1080p_av1:hevc": 0.45,
  "1080p_av1:other": 0.35,
  "original_av1:h264": 0.35,
  "original_av1:hevc": 0.55,
  "original_av1:other": 0.45,
};

type HistoricalRatios = Map<string, { avgRatio: number; count: number }>;

function getCodecCategory(codec: string | null): string {
  const c = (codec ?? "").toLowerCase();
  if (c.includes("av1")) return "av1";
  if (c.includes("hevc") || c.includes("h265")) return "hevc";
  if (c.includes("h264") || c.includes("avc")) return "h264";
  return "other";
}

/**
 * Service for generating video compression suggestions
 */
export class VideosSuggestionsService {
  /**
   * Phase A: Build historical compression ratios from conversion history
   */
  private async buildHistoricalRatios(): Promise<HistoricalRatios> {
    const rows = await db
      .select({
        preset: conversionHistoryTable.preset,
        codec: conversionHistoryTable.codec,
        avgRatio: sql<number>`AVG(${conversionHistoryTable.outputSizeBytes}::float / NULLIF(${conversionHistoryTable.originalSizeBytes}, 0))`,
        count: sql<number>`COUNT(*)::int`,
      })
      .from(conversionHistoryTable)
      .groupBy(conversionHistoryTable.preset, conversionHistoryTable.codec);

    const ratios: HistoricalRatios = new Map();
    for (const row of rows) {
      if (row.avgRatio != null && row.count > 0) {
        // We key by preset - we'll look up by preset directly
        ratios.set(row.preset, {
          avgRatio: row.avgRatio,
          count: row.count,
        });
      }
    }

    return ratios;
  }

  /**
   * Get estimated output ratio for a given preset and source codec
   */
  private getEstimatedRatio(
    historicalRatios: HistoricalRatios,
    preset: string,
    sourceCodecCategory: string,
  ): { ratio: number; confidence: "high" | "medium" | "low" } {
    // Try exact preset match from history
    const historical = historicalRatios.get(preset);
    if (historical && historical.count >= 5) {
      return { ratio: historical.avgRatio, confidence: "high" };
    }
    if (historical && historical.count >= 2) {
      return { ratio: historical.avgRatio, confidence: "medium" };
    }

    // Fallback to hardcoded defaults
    const key = `${preset}:${sourceCodecCategory}`;
    const fallback = DEFAULT_RATIOS[key];
    if (fallback) {
      return { ratio: fallback, confidence: "low" };
    }

    // Generic fallback
    return { ratio: 0.4, confidence: "low" };
  }

  /**
   * Get compression suggestions for videos
   */
  async getCompressionSuggestions(
    userId: number,
    options: { limit?: number; offset?: number } = {},
  ): Promise<{
    suggestions: CompressionSuggestion[];
    summary: CompressionSuggestionsSummary;
  }> {
    const maxSuggestions = await settingsService.getNumber("max_suggestions");
    const limit = Math.min(options.limit ?? 50, maxSuggestions || 200);
    const offset = options.offset ?? 0;

    // Phase A: Historical ratios
    const historicalRatios = await this.buildHistoricalRatios();
    const historyCount = Array.from(historicalRatios.values()).reduce(
      (sum, v) => sum + v.count,
      0,
    );

    // Phase B: Candidate query
    const pendingJobsSubquery = db
      .select({ videoId: conversionJobsTable.videoId })
      .from(conversionJobsTable)
      .where(
        and(
          eq(conversionJobsTable.videoId, videosTable.id),
          sql`${conversionJobsTable.status} IN ('pending', 'processing')`,
        ),
      );

    const favoriteSubquery = db
      .select({ videoId: favoritesTable.videoId })
      .from(favoritesTable)
      .where(
        and(
          eq(favoritesTable.videoId, videosTable.id),
          eq(favoritesTable.userId, userId),
        ),
      );

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
        lastPlayedAt: sql<Date | null>`MAX(${videoStatsTable.lastPlayedAt})`,
        thumbnailId: thumbnailsTable.id,
        isFavorite: sql<boolean>`EXISTS(${favoriteSubquery})`,
      })
      .from(videosTable)
      .leftJoin(thumbnailsTable, eq(videosTable.id, thumbnailsTable.videoId))
      .leftJoin(videoStatsTable, eq(videosTable.id, videoStatsTable.videoId))
      .where(
        and(
          eq(videosTable.isAvailable, true),
          // Exclude AV1 videos (already optimal codec)
          sql`LOWER(COALESCE(${videosTable.codec}, '')) NOT LIKE '%av1%'`,
          // Exclude videos with pending/processing jobs
          not(exists(pendingJobsSubquery)),
        ),
      )
      .groupBy(videosTable.id, thumbnailsTable.id);

    const now = new Date();

    // Phase C: Scoring
    const suggestions: CompressionSuggestion[] = rows
      .map((row) => {
        const reasons: string[] = [];
        const codecCategory = getCodecCategory(row.codec);
        const isFavorite = row.isFavorite;

        // Determine recommended preset
        const preset = isFavorite ? "original_av1" : "1080p_av1";
        const presetConfig = CONVERSION_PRESETS[preset];

        // Estimate output size
        const { ratio, confidence } = this.getEstimatedRatio(
          historicalRatios,
          preset,
          codecCategory,
        );
        const estimatedOutputBytes = Math.round(row.fileSizeBytes * ratio);
        const estimatedSavingsBytes = row.fileSizeBytes - estimatedOutputBytes;
        const estimatedSavingsPercent =
          row.fileSizeBytes > 0
            ? (estimatedSavingsBytes / row.fileSizeBytes) * 100
            : 0;

        // Bytes per second
        const bytesPerSecond =
          row.durationSeconds && row.durationSeconds > 0
            ? row.fileSizeBytes / row.durationSeconds
            : null;

        // --- Scoring components ---
        const ONE_GB = 1024 ** 3;
        const ONE_MB = 1024 ** 2;

        // Estimated absolute savings (0-50)
        const savingsScore = Math.min(
          50,
          (estimatedSavingsBytes / (5 * ONE_GB)) * 50,
        );

        // Bytes-per-second efficiency (0-25): high bps = easy win
        const bpsScore = bytesPerSecond
          ? Math.min(25, (bytesPerSecond / ONE_MB) * 25)
          : 0;

        // Usage staleness (0-15)
        let stalenessScore = 0;
        let daysSinceLastPlayed: number | null = null;
        if (row.lastPlayedAt) {
          const lastPlayed = new Date(row.lastPlayedAt);
          if (!Number.isNaN(lastPlayed.getTime())) {
            daysSinceLastPlayed =
              (now.getTime() - lastPlayed.getTime()) / (1000 * 60 * 60 * 24);
          }
        }
        if (daysSinceLastPlayed === null || row.totalPlayCount === 0) {
          stalenessScore = 15;
          reasons.push("never-played");
        } else if (daysSinceLastPlayed > 90) {
          stalenessScore = 12;
          reasons.push("stale-playback");
        } else if (daysSinceLastPlayed > 30) {
          stalenessScore = 8;
        } else {
          stalenessScore = 3;
        }

        // Codec inefficiency (0-10)
        let codecScore = 0;
        if (codecCategory === "h264") {
          codecScore = 10;
          reasons.push("codec-inefficient");
        } else if (codecCategory === "other") {
          codecScore = 8;
          reasons.push("codec-inefficient");
        } else if (codecCategory === "hevc") {
          codecScore = 4;
          reasons.push("codec-upgradeable");
        }

        // Additional reasons
        if (estimatedSavingsBytes > ONE_GB) {
          reasons.push("large-savings");
        }
        if (bytesPerSecond && bytesPerSecond > ONE_MB) {
          reasons.push("high-bitrate");
        }

        const priorityScore = Math.round(
          savingsScore + bpsScore + stalenessScore + codecScore,
        );

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
          is_favorite: isFavorite,
          bytes_per_second: bytesPerSecond
            ? Math.round(bytesPerSecond)
            : null,
          estimated_output_bytes: estimatedOutputBytes,
          estimated_savings_bytes: estimatedSavingsBytes,
          estimated_savings_percent: Math.round(estimatedSavingsPercent * 10) / 10,
          confidence,
          priority_score: Math.min(100, priorityScore),
          recommended_preset: preset,
          recommended_preset_name: presetConfig?.name ?? preset,
          reasons,
          thumbnail_id: row.thumbnailId,
          thumbnail_url: row.thumbnailId
            ? `${API_PREFIX}/thumbnails/${row.thumbnailId}/image`
            : null,
        } as CompressionSuggestion;
      })
      .filter((s) => s.estimated_savings_bytes > 0)
      .sort((a, b) => {
        if (b.priority_score !== a.priority_score) {
          return b.priority_score - a.priority_score;
        }
        return b.estimated_savings_bytes - a.estimated_savings_bytes;
      })
      .slice(offset, offset + limit);

    // Build summary
    const allCandidates = rows.filter((r) => {
      const cat = getCodecCategory(r.codec);
      const preset = r.isFavorite ? "original_av1" : "1080p_av1";
      const { ratio } = this.getEstimatedRatio(historicalRatios, preset, cat);
      return r.fileSizeBytes - Math.round(r.fileSizeBytes * ratio) > 0;
    });

    const totalEstimatedSavings = allCandidates.reduce((sum, r) => {
      const cat = getCodecCategory(r.codec);
      const preset = r.isFavorite ? "original_av1" : "1080p_av1";
      const { ratio } = this.getEstimatedRatio(historicalRatios, preset, cat);
      return sum + (r.fileSizeBytes - Math.round(r.fileSizeBytes * ratio));
    }, 0);

    const avgSavingsPercent =
      allCandidates.length > 0
        ? allCandidates.reduce((sum, r) => {
            const cat = getCodecCategory(r.codec);
            const preset = r.isFavorite ? "original_av1" : "1080p_av1";
            const { ratio } = this.getEstimatedRatio(
              historicalRatios,
              preset,
              cat,
            );
            return sum + (1 - ratio) * 100;
          }, 0) / allCandidates.length
        : 0;

    const summary: CompressionSuggestionsSummary = {
      total_candidates: allCandidates.length,
      total_estimated_savings_bytes: totalEstimatedSavings,
      avg_estimated_savings_percent: Math.round(avgSavingsPercent * 10) / 10,
      historical_accuracy_note:
        historyCount >= 10
          ? `Estimates based on ${historyCount} historical conversions`
          : `Limited history (${historyCount} conversions). Estimates use conservative defaults.`,
    };

    return { suggestions, summary };
  }
}

export const videosSuggestionsService = new VideosSuggestionsService();
