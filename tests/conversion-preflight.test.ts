import { expect, it } from "bun:test";
import { CONVERSION_PRESETS } from "@/config/presets";
import { buildConversionPreflight } from "@/modules/conversion/conversion.preflight";
import { buildConversionCalibration } from "@/modules/conversion/conversion.estimator";
import { conversionPreflightSchema } from "@/modules/conversion/conversion.schemas";

const video = {
  id: 42,
  width: 1920,
  height: 1080,
  codec: "h264",
  bitrate: 12_000_000,
  duration_seconds: 600,
  file_size_bytes: 900_000_000,
};

it("uses the real encoder plan and warns when conversion would save little or grow", () => {
  const calibration = buildConversionCalibration([]);
  const useful = buildConversionPreflight(
    video,
    CONVERSION_PRESETS["1080p_av1"]!,
    calibration
  );
  expect(useful.recommendation).toBe("recommended");
  expect(useful.estimated_savings_percent).toBeGreaterThan(20);
  expect(useful.confidence).toBe("low");
  expect(conversionPreflightSchema.safeParse(useful).success).toBe(true);
  const growth = buildConversionPreflight(
    { ...video, bitrate: 100_000, file_size_bytes: 7_500_000 },
    CONVERSION_PRESETS["1080p_h264"]!,
    calibration
  );
  expect(growth.recommendation).toBe("unlikely");
  expect(growth.estimated_savings_percent).toBeLessThan(0);
});

it("reports unknown rather than inventing savings when metadata is incomplete", () => {
  const result = buildConversionPreflight(
    { ...video, duration_seconds: null },
    CONVERSION_PRESETS["1080p_av1"]!,
    buildConversionCalibration([])
  );
  expect(result).toMatchObject({
    recommendation: "unknown",
    estimated_output_bytes: null,
    reason: "insufficient_metadata",
  });
});

it("incorporates compatible history without making an optimistic savings promise", () => {
  const calibration = buildConversionCalibration(
    Array.from({ length: 30 }, () => ({
      preset: "1080p_av1",
      profileVersion: 2,
      sourceBitrate: video.bitrate,
      sourceCodec: video.codec,
      outputWidth: video.width,
      outputHeight: video.height,
      originalSizeBytes: video.file_size_bytes,
      outputSizeBytes: video.file_size_bytes * 0.95,
    }))
  );
  const result = buildConversionPreflight(
    video,
    CONVERSION_PRESETS["1080p_av1"]!,
    calibration
  );
  expect(result).toMatchObject({
    recommendation: "unlikely",
    historical_sample_count: 30,
    confidence: "high",
  });
  expect(result.estimated_savings_percent).toBeCloseTo(5);
});
