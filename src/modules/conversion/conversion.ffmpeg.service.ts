/**
 * FFmpeg execution service
 * Handles FFmpeg command building and video encoding with VAAPI GPU acceleration
 */
import { spawn } from "child_process";
import { env } from "@/config/env";
import { InternalServerError } from "@/utils/errors";
import { logger } from "@/utils/logger";
import type { Video } from "@/modules/videos/videos.types";
import type { ConversionPreset } from "@/config/presets";
import { MIN_HEIGHT_FOR_720P } from "@/config/presets";

export class FfmpegService {
  /**
   * Run FFmpeg with VAAPI GPU acceleration
   */
  async runConversion(
    jobId: number,
    video: Video,
    inputPath: string,
    outputPath: string,
    preset: ConversionPreset,
    targetResolution: string | null,
    onProgress?: (progress: number) => void,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const args: string[] = [
        "-init_hw_device",
        `vaapi=va:${env.VAAPI_DEVICE}`,
        "-hwaccel",
        "vaapi",
        "-hwaccel_device",
        "va",
        "-hwaccel_output_format",
        "vaapi",
        "-i",
        inputPath,
        "-filter_hw_device",
        "va",
      ];

      const targetWidth =
        targetResolution && targetResolution !== "original"
          ? parseInt(targetResolution.split("x")[0], 10)
          : null;

      const { bitrate, maxrate, bufsize } = this.calculateTargetBitrate(
        video,
        preset,
        targetWidth,
      );

      if (targetResolution && targetResolution !== "original") {
        const [width] = targetResolution.split("x");
        args.push("-vf", `scale_vaapi=w=${width}:h=-2`);
      }

      args.push(
        "-c:v",
        preset.codec,
        ...this.getEncoderOptions(preset, bitrate, maxrate, bufsize),
        "-c:a",
        "aac",
        "-b:a",
        preset.audioBitrate,
        "-y",
        "-progress",
        "pipe:1",
        outputPath,
      );

      logger.debug({ jobId, args }, "Starting FFmpeg");

      const ffmpeg = spawn(env.FFMPEG_PATH, args);
      let duration = 0;
      let lastProgress = 0;

      this.getVideoDuration(inputPath)
        .then((d) => {
          duration = d;
        })
        .catch(() => {
          // If we can't get duration, progress updates won't work but conversion continues
        });

      ffmpeg.stdout.on("data", (data: Buffer) => {
        const output = data.toString();

        const timeMatch = output.match(/out_time_ms=(\d+)/);
        if (timeMatch && duration > 0) {
          const currentSeconds = parseInt(timeMatch[1], 10) / 1000000; // out_time_ms is actually in microseconds
          const progress = Math.min(
            99,
            Math.round((currentSeconds / duration) * 100),
          );

          if (progress > lastProgress + 2) {
            lastProgress = progress;

            if (onProgress) {
              onProgress(progress);
            }
          }
        }
      });

      ffmpeg.stderr.on("data", (data: Buffer) => {
        logger.debug(
          { jobId, ffmpeg: data.toString().trim() },
          "FFmpeg output",
        );
      });

      ffmpeg.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`FFmpeg exited with code ${code}`));
        }
      });

      ffmpeg.on("error", (error) => {
        reject(new InternalServerError(`FFmpeg error: ${error.message}`));
      });
    });
  }

  /**
   * Calculate target bitrate based on video and preset
   */
  private calculateTargetBitrate(
    video: Video,
    preset: ConversionPreset,
    targetWidth: number | null,
  ): { bitrate: string; maxrate: string; bufsize: string } {
    const codecType = preset.codec.replace("_vaapi", "") as
      | "av1"
      | "hevc"
      | "h264";

    const effectiveWidth =
      targetWidth ?? video.width ?? preset.targetWidth ?? 1920;
    const presetMaxBitrate = targetWidth
      ? (preset.maxBitrate ?? this.getMaxRate(targetWidth, codecType))
      : this.getMaxRate(effectiveWidth, codecType);

    const presetMaxMbps = parseInt(presetMaxBitrate.replace("M", ""), 10);
    const sourceBitrateMbps = video.bitrate
      ? Math.round(video.bitrate / 1_000_000)
      : null;

    let targetBitrateMbps = sourceBitrateMbps
      ? Math.min(presetMaxMbps, Math.round(sourceBitrateMbps * 1.1))
      : presetMaxMbps;

    targetBitrateMbps = Math.max(targetBitrateMbps, 1);

    const maxrateMbps = Math.min(
      presetMaxMbps,
      Math.max(targetBitrateMbps, Math.round(targetBitrateMbps * 1.2)),
    );

    const maxrate = `${maxrateMbps}M`;

    return {
      bitrate: `${targetBitrateMbps}M`,
      maxrate,
      bufsize: this.getBufSize(maxrate),
    };
  }

  /**
   * Get encoder-specific options
   */
  private getEncoderOptions(
    preset: ConversionPreset,
    bitrate: string,
    maxrate: string,
    bufsize: string,
  ): string[] {
    const baseOptions = ["-async_depth", "4"];

    switch (preset.codec) {
      case "av1_vaapi":
        return [
          ...baseOptions,
          "-rc_mode",
          "VBR",
          "-b:v",
          bitrate,
          "-maxrate",
          maxrate,
          "-bufsize",
          bufsize,
          "-global_quality",
          preset.qp.toString(),
        ];

      case "hevc_vaapi":
        return [
          ...baseOptions,
          "-rc_mode",
          "VBR",
          "-b:v",
          bitrate,
          "-maxrate",
          maxrate,
          "-bufsize",
          bufsize,
          "-qp",
          preset.qp.toString(),
        ];

      case "h264_vaapi":
        return [
          ...baseOptions,
          "-rc_mode",
          "VBR",
          "-b:v",
          bitrate,
          "-maxrate",
          maxrate,
          "-bufsize",
          bufsize,
          "-qp",
          preset.qp.toString(),
          "-profile:v",
          "high",
        ];

      default:
        return ["-global_quality", preset.qp.toString()];
    }
  }

  /**
   * Get max bitrate for resolution and codec
   */
  private getMaxRate(width: number, codec: "av1" | "hevc" | "h264"): string {
    // Bitrate caps based on resolution and codec efficiency
    const rates: Record<string, Record<number, string>> = {
      av1: {
        3840: "25M",
        2560: "15M",
        1920: "6M",
        1280: "4M",
        854: "3M",
      },
      hevc: {
        3840: "35M",
        2560: "20M",
        1920: "15M",
        1280: "8M",
        854: "4M",
      },
      h264: {
        3840: "50M",
        2560: "30M",
        1920: "20M",
        1280: "10M",
        854: "5M",
      },
    };

    const codecRates = rates[codec];
    const widths = Object.keys(codecRates)
      .map(Number)
      .sort((a, b) => b - a);

    for (const w of widths) {
      if (width >= w) {
        return codecRates[w];
      }
    }

    return codecRates[widths[widths.length - 1]];
  }

  /**
   * Get buffer size (typically 2x maxrate)
   */
  private getBufSize(maxRate: string): string {
    const value = parseInt(maxRate.replace("M", ""), 10);
    return `${value * 2}M`;
  }

  /**
   * Get video duration in seconds using FFprobe
   */
  private getVideoDuration(inputPath: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const args = [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        inputPath,
      ];

      const ffprobe = spawn(env.FFPROBE_PATH, args);
      let output = "";

      ffprobe.stdout.on("data", (data: Buffer) => {
        output += data.toString();
      });

      ffprobe.on("close", (code) => {
        if (code === 0) {
          const duration = parseFloat(output.trim());
          if (!isNaN(duration)) {
            resolve(duration);
          } else {
            reject(new Error("Failed to parse duration"));
          }
        } else {
          reject(new Error(`FFprobe exited with code ${code}`));
        }
      });

      ffprobe.on("error", reject);
    });
  }

  /**
   * Calculate target resolution based on video dimensions and preset
   */
  calculateTargetResolution(
    width: number | null,
    height: number | null,
    preset: ConversionPreset,
  ): string {
    // If preset wants original, always keep original
    if (preset.targetWidth === null) {
      return "original";
    }

    // If we don't know video dimensions, use preset target
    if (!width || !height) {
      return `${preset.targetWidth}x-2`;
    }

    // If video is smaller than 720p, keep original
    if (height < MIN_HEIGHT_FOR_720P) {
      return "original";
    }

    // If video is smaller than target width, keep original
    if (width <= preset.targetWidth) {
      return "original";
    }

    // Target width with auto height (aspect ratio preserved)
    return `${preset.targetWidth}x-2`;
  }
}

export const ffmpegService = new FfmpegService();
