import { describe, expect, it } from "bun:test";
import { conversionInsightsService } from "@/modules/conversion/conversion.insights.service";
import type { ConversionHistoryRecord } from "@/modules/conversion/conversion.types";

function historyRow(options: {
  id: number;
  sourceMbps: number;
  outputMbps: number;
  width: number;
  height: number;
}): ConversionHistoryRecord {
  const durationSeconds = 100;
  const originalSizeBytes = Math.round(
    (options.sourceMbps * 1_000_000 * durationSeconds) / 8,
  );
  const outputSizeBytes = Math.round(
    (options.outputMbps * 1_000_000 * durationSeconds) / 8,
  );
  const sizeDeltaBytes = outputSizeBytes - originalSizeBytes;

  return {
    id: options.id,
    conversion_job_id: options.id,
    video_id: options.id,
    source_video_deleted: false,
    source_file_path: "[redacted]",
    source_file_name: "[redacted]",
    output_file_path: "[redacted]",
    preset: "1080p_av1",
    codec: "av1_vaapi",
    target_resolution: "original",
    ffmpeg_command: "[redacted]",
    original_size_bytes: originalSizeBytes,
    output_size_bytes: outputSizeBytes,
    size_delta_bytes: sizeDeltaBytes,
    size_change_percent: (sizeDeltaBytes / originalSizeBytes) * 100,
    conversion_duration_ms: 10_000,
    duration_seconds: durationSeconds,
    source_width: options.width,
    source_height: options.height,
    source_fps: 30,
    source_codec: "h264",
    source_audio_codec: "aac",
    source_bitrate: Math.round(options.sourceMbps * 1_000_000),
    output_width: options.width,
    output_height: options.height,
    output_fps: 30,
    output_codec: "av1",
    output_audio_codec: "opus",
    output_bitrate: Math.round(options.outputMbps * 1_000_000),
    profile_version: 2,
    planned_video_bitrate: Math.round((options.outputMbps - 0.096) * 1_000_000),
    planned_max_bitrate: Math.round(options.outputMbps * 1_000_000),
    planned_qp: 42,
    effective_resolution: `${options.width}x${options.height}`,
    encoding_mode: "hw",
    encode_speed_ratio: 10,
    started_at: "2026-07-30T00:00:00.000Z",
    completed_at: "2026-07-30T00:00:10.000Z",
    created_at: "2026-07-30T00:00:10.000Z",
  };
}

describe("conversion insights", () => {
  it("calculates break-even independently for effective output resolutions", () => {
    const rows: ConversionHistoryRecord[] = [];
    let id = 1;

    for (let index = 0; index < 3; index += 1) {
      rows.push(
        historyRow({
          id: id++,
          sourceMbps: 5.5,
          outputMbps: 6,
          width: 1920,
          height: 1080,
        }),
        historyRow({
          id: id++,
          sourceMbps: 6.5,
          outputMbps: 6,
          width: 1920,
          height: 1080,
        }),
        historyRow({
          id: id++,
          sourceMbps: 7.5,
          outputMbps: 6,
          width: 1920,
          height: 1080,
        }),
        historyRow({
          id: id++,
          sourceMbps: 3.5,
          outputMbps: 4,
          width: 1280,
          height: 720,
        }),
        historyRow({
          id: id++,
          sourceMbps: 4.5,
          outputMbps: 4,
          width: 1280,
          height: 720,
        }),
        historyRow({
          id: id++,
          sourceMbps: 5.5,
          outputMbps: 4,
          width: 1280,
          height: 720,
        }),
      );
    }

    const insights = conversionInsightsService.analyze(rows);
    const fullHd = insights.break_even.find(
      (entry) => entry.resolution_key === "1080p",
    );
    const hd = insights.break_even.find(
      (entry) => entry.resolution_key === "720p",
    );

    expect(fullHd?.crossover_bitrate).toBe(6_000_000);
    expect(hd?.crossover_bitrate).toBe(4_000_000);
  });

  it("redacts sensitive history fields from best and worst records", () => {
    const insights = conversionInsightsService.analyze([
      historyRow({
        id: 1,
        sourceMbps: 12,
        outputMbps: 6,
        width: 1920,
        height: 1080,
      }),
    ]);

    expect(insights.best).toHaveLength(1);
    expect("source_file_name" in insights.best[0]!).toBe(false);
    expect("source_file_path" in insights.best[0]!).toBe(false);
    expect("ffmpeg_command" in insights.best[0]!).toBe(false);
  });
});
