import type { ConversionPreset } from "@/config/presets";
import type { Video } from "@/modules/videos/videos.types";
import {
  buildConversionBitratePlan,
  calculateEffectiveDimensions,
  calculateTargetResolution,
} from "./conversion.planning";
import {
  classifyCompressionRecommendation,
  estimateConversion,
  type ConversionCalibration,
} from "./conversion.estimator";

type PreflightSource = Pick<
  Video,
  | "id"
  | "width"
  | "height"
  | "codec"
  | "bitrate"
  | "duration_seconds"
  | "file_size_bytes"
>;

export function buildConversionPreflight(
  video: PreflightSource,
  preset: ConversionPreset,
  calibration: ConversionCalibration
) {
  const targetResolution = calculateTargetResolution(
    video.width,
    video.height,
    preset
  );
  const dimensions = calculateEffectiveDimensions(
    video.width,
    video.height,
    targetResolution
  );
  const common = {
    video_id: video.id,
    preset: preset.id,
    source_size_bytes: video.file_size_bytes,
    target_resolution: targetResolution,
  };
  if (
    !dimensions ||
    !video.duration_seconds ||
    video.duration_seconds <= 0 ||
    !video.bitrate ||
    video.bitrate <= 0 ||
    video.file_size_bytes <= 0
  ) {
    return {
      ...common,
      estimated_output_bytes: null,
      estimated_savings_bytes: null,
      estimated_savings_percent: null,
      confidence: "low" as const,
      historical_sample_count: 0,
      prediction_error_percent: null,
      recommendation: "unknown" as const,
      reason: "insufficient_metadata" as const,
    };
  }
  const plan = buildConversionBitratePlan(video, preset, targetResolution);
  const estimate = estimateConversion(
    {
      preset: preset.id,
      profileVersion: plan.profileVersion,
      sourceBitrate: video.bitrate,
      sourceCodec: video.codec,
      effectiveWidth: dimensions.width,
      effectiveHeight: dimensions.height,
      originalSizeBytes: video.file_size_bytes,
      durationSeconds: video.duration_seconds,
      plan,
    },
    calibration
  );
  const recommendation = classifyCompressionRecommendation(
    estimate.estimatedSavingsPercent,
    estimate.estimatedSavingsBytes
  );
  return {
    ...common,
    estimated_output_bytes: estimate.estimatedOutputBytes,
    estimated_savings_bytes: estimate.estimatedSavingsBytes,
    estimated_savings_percent: estimate.estimatedSavingsPercent,
    confidence: estimate.confidence,
    historical_sample_count: estimate.historicalSampleCount,
    prediction_error_percent: estimate.predictionErrorPercent,
    recommendation: recommendation ?? ("unlikely" as const),
    reason: recommendation ? null : ("little_or_no_savings" as const),
  };
}
