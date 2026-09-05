import { eq, sql, and, not, exists } from "drizzle-orm";
import { db } from "@/config/drizzle";
import { env } from "@/config/env";
import {
  videosTable,
  videoStatsTable,
  thumbnailsTable,
  favoritesTable,
  conversionJobsTable,
} from "@/database/schema";
import { CONVERSION_PRESETS } from "@/config/presets";
import { settingsService } from "@/modules/settings/settings.service";
import { conversionCalibrationService } from "@/modules/conversion/conversion.calibration.service";
import { API_PREFIX } from "@/config/constants";
import {
  buildConversionBitratePlan,
  calculateEffectiveDimensions,
  calculateTargetResolution,
  formatEffectiveResolution,
} from "@/modules/conversion/conversion.planning";
import {
  classifyCompressionRecommendation,
  estimateConversion,
  USEFUL_ABSOLUTE_SAVINGS_BYTES,
} from "@/modules/conversion/conversion.estimator";
import type {
  CompressionSuggestion,
  CompressionSuggestionsSummary,
  Video,
} from "./videos.types";

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
  private buildCalibration() {
    return conversionCalibrationService.get();
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

    if (env.DEMO_MODE) {
      const { demoRepository } = await import("@/database/demo/repository");
      const videosObj = demoRepository.getVideos({ limit: 100 });
      const candidates = (videosObj.data as Video[]).filter(
        (v) => !v.codec?.toLowerCase().includes("av1"),
      );

      const suggestions: CompressionSuggestion[] = candidates.map((v) => {
        const fileSizeBytes = v.file_size_bytes;
        const estimatedOutputBytes = Math.round(fileSizeBytes * 0.35);
        const estimatedSavingsBytes = fileSizeBytes - estimatedOutputBytes;
        const estimatedSavingsPercent = 65.0;

        return {
          video_id: v.id,
          file_name: v.file_name,
          file_size_bytes: fileSizeBytes,
          width: v.width,
          height: v.height,
          codec: v.codec,
          bitrate: v.bitrate,
          fps: v.fps,
          duration_seconds: v.duration_seconds,
          is_favorite: v.is_favorite,
          bytes_per_second: v.duration_seconds
            ? Math.round(fileSizeBytes / v.duration_seconds)
            : null,
          estimated_output_bytes: estimatedOutputBytes,
          estimated_savings_bytes: estimatedSavingsBytes,
          estimated_savings_percent: estimatedSavingsPercent,
          confidence: "low",
          historical_sample_count: 0,
          prediction_error_percent: null,
          priority_score: 85,
          recommended_preset: "1080p_av1",
          recommended_preset_name: "AV1 up to 1080p",
          expected_target_resolution: "original",
          effective_resolution:
            v.width && v.height ? `${v.width}x${v.height}` : null,
          profile_version: 2,
          planned_video_bitrate: Math.max(
            100_000,
            (v.bitrate ?? 6_096_000) - 96_000,
          ),
          planned_max_bitrate: Math.min(v.bitrate ?? 6_000_000, 6_000_000),
          recommendation_tier:
            estimatedSavingsBytes >= USEFUL_ABSOLUTE_SAVINGS_BYTES
              ? "recommended"
              : "marginal",
          reasons: ["codec-inefficient", "large-savings"],
          thumbnail_id: v.thumbnail_id,
          thumbnail_url: v.thumbnail_url,
        } as CompressionSuggestion;
      });

      const totalEstimatedSavings = suggestions.reduce(
        (sum, s) => sum + s.estimated_savings_bytes,
        0,
      );
      const avgSavingsPercent = suggestions.length > 0 ? 65.0 : 0;

      return {
        suggestions: suggestions.slice(offset, offset + limit),
        summary: {
          total_candidates: suggestions.length,
          total_estimated_savings_bytes: totalEstimatedSavings,
          avg_estimated_savings_percent: avgSavingsPercent,
          historical_accuracy_note:
            "Demo Mode Active - Mocked estimates based on demo data",
        },
      };
    }

    const { calibration, historyCount } = await this.buildCalibration();

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

    const eligibleSuggestions = rows
      .map((row) => {
        if (
          row.fileSizeBytes <= 0 ||
          !row.width ||
          !row.height ||
          !row.bitrate ||
          !row.durationSeconds
        ) {
          return null;
        }

        const reasons: string[] = [];
        const codecCategory = getCodecCategory(row.codec);
        const isFavorite = row.isFavorite;

        const preset = isFavorite ? "original_av1" : "1080p_av1";
        const presetConfig = CONVERSION_PRESETS[preset];
        if (!presetConfig) {
          return null;
        }

        const targetResolution = calculateTargetResolution(
          row.width,
          row.height,
          presetConfig,
        );
        const effectiveDimensions = calculateEffectiveDimensions(
          row.width,
          row.height,
          targetResolution,
        );
        if (!effectiveDimensions) {
          return null;
        }

        const plan = buildConversionBitratePlan(
          {
            width: row.width,
            height: row.height,
            bitrate: row.bitrate,
          },
          presetConfig,
          targetResolution,
        );
        const estimate = estimateConversion(
          {
            preset,
            profileVersion: plan.profileVersion,
            sourceBitrate: row.bitrate,
            sourceCodec: row.codec,
            effectiveWidth: effectiveDimensions.width,
            effectiveHeight: effectiveDimensions.height,
            originalSizeBytes: row.fileSizeBytes,
            durationSeconds: row.durationSeconds,
            plan,
          },
          calibration,
        );

        const recommendationTier = classifyCompressionRecommendation(
          estimate.estimatedSavingsPercent,
          estimate.estimatedSavingsBytes,
        );
        if (!recommendationTier) {
          return null;
        }

        if (recommendationTier === "marginal") {
          reasons.push("marginal-savings");
        } else {
          reasons.push("meaningful-savings");
        }
        if (estimate.historicalSampleCount > 0) {
          reasons.push("historically-calibrated");
        }
        if (estimate.usedSourceCodec) {
          reasons.push("source-codec-calibrated");
        }
        if (estimate.usedCurrentProfileVersion) {
          reasons.push("profile-version-calibrated");
        }

        const estimatedOutputBytes = estimate.estimatedOutputBytes;
        const estimatedSavingsBytes = estimate.estimatedSavingsBytes;
        const estimatedSavingsPercent = estimate.estimatedSavingsPercent;

        const bytesPerSecond = row.fileSizeBytes / row.durationSeconds;
        const ONE_GB = 1024 ** 3;
        const ONE_MB = 1024 ** 2;

        const savingsScore = Math.min(
          50,
          (estimatedSavingsBytes / (5 * ONE_GB)) * 50,
        );
        const percentageScore = Math.min(25, estimatedSavingsPercent);
        const usefulSavingsBonus =
          estimatedSavingsBytes >= USEFUL_ABSOLUTE_SAVINGS_BYTES ? 15 : 0;
        const recommendationBonus =
          recommendationTier === "recommended" ? 15 : 0;

        const bpsScore = Math.min(15, (bytesPerSecond / ONE_MB) * 15);

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

        if (estimatedSavingsBytes > ONE_GB) {
          reasons.push("large-savings");
        }
        if (bytesPerSecond > ONE_MB) {
          reasons.push("high-bitrate");
        }

        const priorityScore = Math.round(
          savingsScore +
            percentageScore +
            usefulSavingsBonus +
            recommendationBonus +
            bpsScore +
            stalenessScore +
            codecScore,
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
          bytes_per_second: Math.round(bytesPerSecond),
          estimated_output_bytes: estimatedOutputBytes,
          estimated_savings_bytes: estimatedSavingsBytes,
          estimated_savings_percent:
            Math.round(estimatedSavingsPercent * 10) / 10,
          confidence: estimate.confidence,
          historical_sample_count: estimate.historicalSampleCount,
          prediction_error_percent:
            estimate.predictionErrorPercent === null
              ? null
              : Math.round(estimate.predictionErrorPercent * 10) / 10,
          priority_score: Math.min(100, priorityScore),
          recommended_preset: preset,
          recommended_preset_name: presetConfig?.name ?? preset,
          expected_target_resolution: targetResolution,
          effective_resolution: formatEffectiveResolution(
            effectiveDimensions,
            targetResolution,
          ),
          profile_version: plan.profileVersion,
          planned_video_bitrate: plan.videoBitrateBps,
          planned_max_bitrate: plan.maxBitrateBps,
          recommendation_tier: recommendationTier,
          reasons,
          thumbnail_id: row.thumbnailId,
          thumbnail_url: row.thumbnailId
            ? `${API_PREFIX}/thumbnails/${row.thumbnailId}/image`
            : null,
        } satisfies CompressionSuggestion;
      })
      .filter(
        (suggestion): suggestion is NonNullable<typeof suggestion> =>
          suggestion !== null,
      )
      .sort((a, b) => {
        if (a.recommendation_tier !== b.recommendation_tier) {
          return a.recommendation_tier === "recommended" ? -1 : 1;
        }
        if (b.priority_score !== a.priority_score) {
          return b.priority_score - a.priority_score;
        }
        return b.estimated_savings_bytes - a.estimated_savings_bytes;
      });

    const suggestions = eligibleSuggestions.slice(offset, offset + limit);
    const totalEstimatedSavings = eligibleSuggestions.reduce(
      (sum, suggestion) => sum + suggestion.estimated_savings_bytes,
      0,
    );
    const avgSavingsPercent =
      eligibleSuggestions.length > 0
        ? eligibleSuggestions.reduce(
            (sum, suggestion) => sum + suggestion.estimated_savings_percent,
            0,
          ) / eligibleSuggestions.length
        : 0;

    const summary: CompressionSuggestionsSummary = {
      total_candidates: eligibleSuggestions.length,
      total_estimated_savings_bytes: totalEstimatedSavings,
      avg_estimated_savings_percent: Math.round(avgSavingsPercent * 10) / 10,
      historical_accuracy_note:
        `${historyCount} historical conversions available. ` +
        "Confidence is calculated from the matching resolution, bitrate, profile-version, and source-codec segment.",
    };

    return { suggestions, summary };
  }
}

export const videosSuggestionsService = new VideosSuggestionsService();
