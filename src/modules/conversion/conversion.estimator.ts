import {
  classifyBitrate,
  classifyResolution,
  UNKNOWN_BUCKET_KEY,
} from "./conversion.buckets";
import type { ConversionBitratePlan } from "./conversion.planning";

export const MIN_SOURCE_CODEC_CALIBRATION_SAMPLES = 20;
export const MIN_COMPRESSION_SAVINGS_PERCENT = 10;
export const RECOMMENDED_COMPRESSION_SAVINGS_PERCENT = 20;
export const USEFUL_ABSOLUTE_SAVINGS_BYTES = 100 * 1024 * 1024;
const MIN_MEDIUM_CONFIDENCE_SAMPLES = 10;
const MIN_HIGH_CONFIDENCE_SAMPLES = 30;

export type CompressionRecommendationTier = "recommended" | "marginal";

export function classifyCompressionRecommendation(
  savingsPercent: number,
  savingsBytes: number,
): CompressionRecommendationTier | null {
  if (savingsPercent < MIN_COMPRESSION_SAVINGS_PERCENT || savingsBytes <= 0) {
    return null;
  }

  return savingsPercent >= RECOMMENDED_COMPRESSION_SAVINGS_PERCENT &&
    savingsBytes >= USEFUL_ABSOLUTE_SAVINGS_BYTES
    ? "recommended"
    : "marginal";
}

export interface ConversionCalibrationSample {
  preset: string;
  profileVersion: number | null;
  sourceBitrate: number | null;
  sourceCodec: string | null;
  outputWidth: number | null;
  outputHeight: number | null;
  originalSizeBytes: number;
  outputSizeBytes: number;
}

export interface ConversionEstimateInput {
  preset: string;
  profileVersion: number;
  sourceBitrate: number;
  sourceCodec: string | null;
  effectiveWidth: number;
  effectiveHeight: number;
  originalSizeBytes: number;
  durationSeconds: number;
  plan: ConversionBitratePlan;
}

export interface ConversionEstimate {
  estimatedOutputBytes: number;
  estimatedSavingsBytes: number;
  estimatedSavingsPercent: number;
  confidence: "high" | "medium" | "low";
  historicalSampleCount: number;
  predictionErrorPercent: number | null;
  usedSourceCodec: boolean;
  usedCurrentProfileVersion: boolean;
}

interface CalibrationSegment {
  sampleCount: number;
  medianRatio: number;
  meanAbsoluteErrorPercent: number;
  profileVersion: number | null;
  usesSourceCodec: boolean;
}

export interface ConversionCalibration {
  exact: Map<string, CalibrationSegment>;
  anyVersion: Map<string, CalibrationSegment>;
}

function codecCategory(codec: string | null): string {
  const normalized = (codec ?? "").toLowerCase();
  if (normalized.includes("av1")) return "av1";
  if (normalized.includes("hevc") || normalized.includes("h265")) return "hevc";
  if (normalized.includes("h264") || normalized.includes("avc")) return "h264";
  if (normalized.includes("vp9")) return "vp9";
  return "other";
}

function segmentDimensions(
  width: number | null,
  height: number | null,
): string {
  return classifyResolution(width, height)?.key ?? UNKNOWN_BUCKET_KEY;
}

function segmentBitrate(bitrate: number | null): string {
  return classifyBitrate(bitrate)?.key ?? UNKNOWN_BUCKET_KEY;
}

function segmentKey(options: {
  preset: string;
  resolution: string;
  bitrate: string;
  profileVersion?: number | null;
  codec?: string;
}): string {
  return [
    options.preset,
    options.resolution,
    options.bitrate,
    options.profileVersion === undefined
      ? "*"
      : (options.profileVersion ?? "legacy"),
    options.codec ?? "*",
  ].join("|");
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

function makeSegment(
  ratios: number[],
  profileVersion: number | null,
  usesSourceCodec: boolean,
): CalibrationSegment {
  const medianRatio = median(ratios);
  const meanAbsoluteErrorPercent =
    (ratios.reduce((total, ratio) => total + Math.abs(ratio - medianRatio), 0) /
      ratios.length) *
    100;

  return {
    sampleCount: ratios.length,
    medianRatio,
    meanAbsoluteErrorPercent,
    profileVersion,
    usesSourceCodec,
  };
}

export function buildConversionCalibration(
  rows: ConversionCalibrationSample[],
): ConversionCalibration {
  const exactGroups = new Map<
    string,
    {
      ratios: number[];
      profileVersion: number | null;
      usesSourceCodec: boolean;
    }
  >();
  const anyVersionGroups = new Map<
    string,
    { ratios: number[]; usesSourceCodec: boolean }
  >();

  const add = (
    groups: Map<
      string,
      {
        ratios: number[];
        profileVersion?: number | null;
        usesSourceCodec: boolean;
      }
    >,
    key: string,
    ratio: number,
    profileVersion: number | null | undefined,
    usesSourceCodec: boolean,
  ) => {
    const group = groups.get(key);
    if (group) {
      group.ratios.push(ratio);
      return;
    }

    groups.set(key, {
      ratios: [ratio],
      profileVersion,
      usesSourceCodec,
    });
  };

  for (const row of rows) {
    if (row.originalSizeBytes <= 0 || row.outputSizeBytes <= 0) continue;

    const ratio = row.outputSizeBytes / row.originalSizeBytes;
    const resolution = segmentDimensions(row.outputWidth, row.outputHeight);
    const bitrate = segmentBitrate(row.sourceBitrate);
    const codec = codecCategory(row.sourceCodec);

    for (const codecKey of ["*", codec]) {
      const usesSourceCodec = codecKey !== "*";
      add(
        exactGroups,
        segmentKey({
          preset: row.preset,
          resolution,
          bitrate,
          profileVersion: row.profileVersion,
          codec: codecKey,
        }),
        ratio,
        row.profileVersion,
        usesSourceCodec,
      );
      add(
        anyVersionGroups,
        segmentKey({
          preset: row.preset,
          resolution,
          bitrate,
          codec: codecKey,
        }),
        ratio,
        undefined,
        usesSourceCodec,
      );
    }
  }

  const exact = new Map<string, CalibrationSegment>();
  for (const [key, group] of exactGroups) {
    if (
      group.usesSourceCodec &&
      group.ratios.length < MIN_SOURCE_CODEC_CALIBRATION_SAMPLES
    ) {
      continue;
    }
    exact.set(
      key,
      makeSegment(
        group.ratios,
        group.profileVersion ?? null,
        group.usesSourceCodec,
      ),
    );
  }

  const anyVersion = new Map<string, CalibrationSegment>();
  for (const [key, group] of anyVersionGroups) {
    if (
      group.usesSourceCodec &&
      group.ratios.length < MIN_SOURCE_CODEC_CALIBRATION_SAMPLES
    ) {
      continue;
    }
    anyVersion.set(key, makeSegment(group.ratios, null, group.usesSourceCodec));
  }

  return { exact, anyVersion };
}

function confidenceFor(
  segment: CalibrationSegment | null,
  usedCurrentProfileVersion: boolean,
): "high" | "medium" | "low" {
  if (!segment || !usedCurrentProfileVersion) {
    return "low";
  }

  if (
    segment.sampleCount >= MIN_HIGH_CONFIDENCE_SAMPLES &&
    segment.meanAbsoluteErrorPercent <= 10
  ) {
    return "high";
  }

  if (
    segment.sampleCount >= MIN_MEDIUM_CONFIDENCE_SAMPLES &&
    segment.meanAbsoluteErrorPercent <= 20
  ) {
    return "medium";
  }

  return "low";
}

export function estimateConversion(
  input: ConversionEstimateInput,
  calibration: ConversionCalibration,
): ConversionEstimate {
  const resolution = segmentDimensions(
    input.effectiveWidth,
    input.effectiveHeight,
  );
  const bitrate = segmentBitrate(input.sourceBitrate);
  const codec = codecCategory(input.sourceCodec);
  const exactCodecKey = segmentKey({
    preset: input.preset,
    resolution,
    bitrate,
    profileVersion: input.profileVersion,
    codec,
  });
  const exactBaseKey = segmentKey({
    preset: input.preset,
    resolution,
    bitrate,
    profileVersion: input.profileVersion,
  });
  const anyCodecKey = segmentKey({
    preset: input.preset,
    resolution,
    bitrate,
    codec,
  });
  const anyBaseKey = segmentKey({
    preset: input.preset,
    resolution,
    bitrate,
  });

  const segment =
    calibration.exact.get(exactCodecKey) ??
    calibration.exact.get(exactBaseKey) ??
    calibration.anyVersion.get(anyCodecKey) ??
    calibration.anyVersion.get(anyBaseKey) ??
    null;
  const usedCurrentProfileVersion =
    segment !== null &&
    segment.profileVersion !== null &&
    segment.profileVersion === input.profileVersion;

  const plannedTotalBitrate =
    input.plan.videoBitrateBps + input.plan.audioBitrateBps;
  const plannedOutputBytes = Math.round(
    (plannedTotalBitrate * input.durationSeconds) / 8,
  );
  const plannedRatio = plannedOutputBytes / input.originalSizeBytes;

  // Calibration can only make the estimate more conservative. A historical
  // segment that performed better than the current plan must not create
  // savings the encoder itself is not planning to deliver.
  const estimatedRatio = Math.max(plannedRatio, segment?.medianRatio ?? 0);
  const estimatedOutputBytes = Math.round(
    input.originalSizeBytes * estimatedRatio,
  );
  const estimatedSavingsBytes = input.originalSizeBytes - estimatedOutputBytes;
  const estimatedSavingsPercent =
    input.originalSizeBytes > 0
      ? (estimatedSavingsBytes / input.originalSizeBytes) * 100
      : 0;

  return {
    estimatedOutputBytes,
    estimatedSavingsBytes,
    estimatedSavingsPercent,
    confidence: confidenceFor(segment, usedCurrentProfileVersion),
    historicalSampleCount: segment?.sampleCount ?? 0,
    predictionErrorPercent: segment?.meanAbsoluteErrorPercent ?? null,
    usedSourceCodec: segment?.usesSourceCodec ?? false,
    usedCurrentProfileVersion,
  };
}
