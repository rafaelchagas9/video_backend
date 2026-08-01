import { describe, expect, it } from "bun:test";
import {
  buildConversionCalibration,
  classifyCompressionRecommendation,
  estimateConversion,
  type ConversionCalibrationSample,
} from "@/modules/conversion/conversion.estimator";
import type { ConversionBitratePlan } from "@/modules/conversion/conversion.planning";

const plan: ConversionBitratePlan = {
  profileVersion: 2,
  bitrate: "6000k",
  maxrate: "6000k",
  bufsize: "12000k",
  videoBitrateBps: 6_000_000,
  maxBitrateBps: 6_000_000,
  bufferSizeBps: 12_000_000,
  audioBitrateBps: 96_000,
  qp: 42,
};

function samples(options: {
  count: number;
  profileVersion: number | null;
  codec?: string;
  ratio: number;
}): ConversionCalibrationSample[] {
  return Array.from({ length: options.count }, (_, index) => ({
    preset: "1080p_av1",
    profileVersion: options.profileVersion,
    sourceBitrate: 9_000_000,
    sourceCodec: options.codec ?? "h264",
    outputWidth: 1920,
    outputHeight: 1080,
    originalSizeBytes: 1_000_000,
    outputSizeBytes: Math.round(
      1_000_000 * (options.ratio + ((index % 3) - 1) * 0.005),
    ),
  }));
}

function estimate(
  history: ConversionCalibrationSample[],
  sourceCodec = "h264",
) {
  return estimateConversion(
    {
      preset: "1080p_av1",
      profileVersion: 2,
      sourceBitrate: 9_000_000,
      sourceCodec,
      effectiveWidth: 1920,
      effectiveHeight: 1080,
      originalSizeBytes: 112_500_000,
      durationSeconds: 100,
      plan,
    },
    buildConversionCalibration(history),
  );
}

describe("conversion estimator", () => {
  it("uses matching profile, resolution, bitrate, and codec samples for confidence", () => {
    const result = estimate(
      samples({ count: 30, profileVersion: 2, ratio: 0.75 }),
    );

    expect(result.historicalSampleCount).toBe(30);
    expect(result.usedCurrentProfileVersion).toBe(true);
    expect(result.usedSourceCodec).toBe(true);
    expect(result.confidence).toBe("high");
  });

  it("keeps calibration conservative when history performed better than the plan", () => {
    const result = estimate(
      samples({ count: 30, profileVersion: 2, ratio: 0.5 }),
    );
    const plannedRatio = ((6_000_000 + 96_000) * 100) / 8 / 112_500_000;

    expect(result.estimatedOutputBytes / 112_500_000).toBeCloseTo(
      plannedRatio,
      4,
    );
  });

  it("uses worse historical outcomes to reduce estimated savings", () => {
    const result = estimate(
      samples({ count: 30, profileVersion: 2, ratio: 0.9 }),
    );

    expect(result.estimatedSavingsPercent).toBeCloseTo(10, 1);
  });

  it("downgrades confidence when calibration comes from an older profile version", () => {
    const result = estimate(
      samples({ count: 40, profileVersion: null, ratio: 0.75 }),
    );

    expect(result.historicalSampleCount).toBe(40);
    expect(result.usedCurrentProfileVersion).toBe(false);
    expect(result.confidence).toBe("low");
  });

  it("only uses source codec after the segment has enough samples", () => {
    const sparse = estimate(
      samples({
        count: 19,
        profileVersion: 2,
        codec: "h264",
        ratio: 0.9,
      }),
    );
    expect(sparse.usedSourceCodec).toBe(false);

    const enough = estimate([
      ...samples({
        count: 20,
        profileVersion: 2,
        codec: "h264",
        ratio: 0.9,
      }),
      ...samples({
        count: 20,
        profileVersion: 2,
        codec: "hevc",
        ratio: 0.6,
      }),
    ]);
    expect(enough.usedSourceCodec).toBe(true);
    expect(enough.estimatedSavingsPercent).toBeCloseTo(10, 1);
  });

  it("excludes growth and savings below 10 percent, and marks marginal versus recommended", () => {
    expect(classifyCompressionRecommendation(-2, -10)).toBeNull();
    expect(classifyCompressionRecommendation(9.9, 500_000_000)).toBeNull();
    expect(classifyCompressionRecommendation(15, 500_000_000)).toBe("marginal");
    expect(classifyCompressionRecommendation(25, 50_000_000)).toBe("marginal");
    expect(classifyCompressionRecommendation(25, 500_000_000)).toBe(
      "recommended",
    );
  });
});
