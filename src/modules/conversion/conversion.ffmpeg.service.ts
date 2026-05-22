/**
 * FFmpeg execution service
 * Handles FFmpeg command building and video encoding with VAAPI GPU acceleration
 */
import { spawn } from "child_process";
import { unlink, mkdir, appendFile } from "fs/promises";
import { join } from "path";
import { env } from "@/config/env";
import { InternalServerError } from "@/utils/errors";
import { logger } from "@/utils/logger";
import type { Video } from "@/modules/videos/videos.types";
import type { ConversionPreset, CodecType } from "@/config/presets";
import { MIN_HEIGHT_FOR_720P } from "@/config/presets";
import type { FfmpegRunResult } from "./conversion.types";

type EncodingMode = "hw" | "sw_decode" | "full_sw";

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
  ): Promise<FfmpegRunResult> {
    const [scaleWidth, scaleHeight] =
      targetResolution && targetResolution !== "original"
        ? targetResolution.split("x")
        : [null, null];
    const targetWidth =
      scaleWidth && scaleWidth !== "-2"
        ? parseInt(scaleWidth, 10)
        : scaleHeight && scaleHeight !== "-2"
          ? parseInt(scaleHeight, 10)
          : null;

    const { bitrate, maxrate, bufsize } = this.calculateTargetBitrate(
      video,
      preset,
      targetWidth,
    );

    let inputDuration = 0;
    try {
      inputDuration = await this.getVideoDuration(inputPath);
    } catch {
      // If we can't get duration, progress updates won't work but conversion continues
    }

    let lastProgress = 0;
    const emitProgress = (progress: number): void => {
      if (progress <= lastProgress + 2) {
        return;
      }

      lastProgress = progress;
      onProgress?.(progress);
    };

    const primaryArgs = this.buildArgs({
      inputPath,
      outputPath,
      preset,
      targetResolution,
      bitrate,
      maxrate,
      bufsize,
      encodingMode: "hw",
    });

    const logPath = await this.getLogPath(jobId);

    try {
      return await this.executeFfmpeg({
        jobId,
        args: primaryArgs,
        durationSeconds: inputDuration,
        onProgress: emitProgress,
        logPath,
      });
    } catch (error) {
      if (!this.shouldRetryWithFallback(error)) {
        throw error;
      }

      logger.warn(
        { jobId },
        "Retrying conversion with software decode fallback",
      );

      await unlink(outputPath).catch(() => {});

      const fallbackArgs = this.buildArgs({
        inputPath,
        outputPath,
        preset,
        targetResolution,
        bitrate,
        maxrate,
        bufsize,
        encodingMode: "sw_decode",
      });

      try {
        return await this.executeFfmpeg({
          jobId,
          args: fallbackArgs,
          durationSeconds: inputDuration,
          onProgress: emitProgress,
          logPath,
        });
      } catch (swDecodeError) {
        if (!this.shouldRetryWithFallback(swDecodeError)) {
          throw swDecodeError;
        }

        logger.warn(
          { jobId },
          "Retrying conversion with full software encoding fallback",
        );

        await unlink(outputPath).catch(() => {});

        const fullSwArgs = this.buildArgs({
          inputPath,
          outputPath,
          preset,
          targetResolution,
          bitrate,
          maxrate,
          bufsize,
          encodingMode: "full_sw",
        });

        return this.executeFfmpeg({
          jobId,
          args: fullSwArgs,
          durationSeconds: inputDuration,
          onProgress: emitProgress,
          logPath,
        });
      }
    }
  }

  private buildArgs(options: {
    inputPath: string;
    outputPath: string;
    preset: ConversionPreset;
    targetResolution: string | null;
    bitrate: string;
    maxrate: string;
    bufsize: string;
    encodingMode: EncodingMode;
  }): string[] {
    const {
      inputPath,
      outputPath,
      preset,
      targetResolution,
      bitrate,
      maxrate,
      bufsize,
      encodingMode,
    } = options;

    const args: string[] = [];

    if (encodingMode !== "full_sw") {
      args.push("-init_hw_device", `vaapi=va:${env.VAAPI_DEVICE}`);
    }

    if (encodingMode === "hw") {
      args.push(
        "-hwaccel",
        "vaapi",
        "-hwaccel_device",
        "va",
        "-hwaccel_output_format",
        "vaapi",
      );
    } else {
      args.push("-threads", "0");
    }

    args.push("-i", inputPath);

    if (encodingMode !== "full_sw") {
      args.push("-filter_hw_device", "va");
    }

    const scaleFilter = this.getScaleFilter(
      targetResolution,
      encodingMode === "hw",
    );

    if (encodingMode === "hw") {
      if (scaleFilter) {
        args.push("-vf", scaleFilter);
      }
    } else if (encodingMode === "sw_decode") {
      const fallbackFilter = scaleFilter
        ? `format=nv12,hwupload,${scaleFilter}`
        : "format=nv12,hwupload";
      args.push("-vf", fallbackFilter);
    } else {
      if (scaleFilter) {
        args.push("-vf", scaleFilter);
      }
    }

    const codec =
      encodingMode === "full_sw"
        ? this.getSoftwareCodec(preset.codec)
        : preset.codec;

    args.push(
      "-fps_mode:v",
      "passthrough",
      "-c:v",
      codec,
      ...this.getEncoderOptions(
        preset,
        bitrate,
        maxrate,
        bufsize,
        encodingMode,
      ),
      "-c:a",
      "libopus",
      "-b:a",
      preset.audioBitrate,
      "-vbr",
      "on",
      "-y",
      "-progress",
      "pipe:1",
      outputPath,
    );

    return args;
  }

  private getScaleFilter(
    targetResolution: string | null,
    useHardware: boolean,
  ): string | null {
    if (!targetResolution || targetResolution === "original") {
      return null;
    }

    const [width, height] = targetResolution.split("x");
    const hasWidth = width && width !== "-2";
    const hasHeight = height && height !== "-2";

    if (hasWidth && hasHeight) {
      if (useHardware) {
        return `scale_vaapi=w=${width}:h=${height}:force_original_aspect_ratio=decrease`;
      }
      return `scale=w=${width}:h=${height}:force_original_aspect_ratio=decrease`;
    }

    if (hasWidth) {
      if (useHardware) {
        return `scale_vaapi=w=${width}:h=-2`;
      }
      return `scale=w=${width}:h=-2`;
    }

    if (useHardware) {
      return `scale_vaapi=w=-2:h=${height}`;
    }
    return `scale=w=-2:h=${height}`;
  }

  private getSoftwareCodec(vaapiCodec: CodecType): string {
    const map: Record<CodecType, string> = {
      av1_vaapi: "libsvtav1",
      hevc_vaapi: "libx265",
      h264_vaapi: "libx264",
    };
    return map[vaapiCodec];
  }

  private async writeLogLine(logPath: string, line: string): Promise<void> {
    try {
      await appendFile(logPath, line);
    } catch {
      // Non-fatal: log writing failures shouldn't interrupt conversion
    }
  }

  private async getLogPath(jobId: number): Promise<string> {
    const logsDir = join(env.LOGS_DIR, "ffmpeg");
    await mkdir(logsDir, { recursive: true });
    return join(logsDir, `job-${jobId}.log`);
  }

  private executeFfmpeg(options: {
    jobId: number;
    args: string[];
    durationSeconds: number;
    onProgress: (progress: number) => void;
    logPath: string;
  }): Promise<FfmpegRunResult> {
    const { jobId, args, durationSeconds, onProgress, logPath } = options;

    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const command = this.stringifyCommand(env.FFMPEG_PATH, args);
      const startLine = `\n[${new Date().toISOString()}] Starting FFmpeg\n$ ${command}\n\n`;
      this.writeLogLine(logPath, startLine);

      logger.debug({ jobId, args, command }, "Starting FFmpeg");

      const ffmpeg = spawn(env.FFMPEG_PATH, args);
      let stderrOutput = "";

      ffmpeg.stdout.on("data", (data: Buffer) => {
        const output = data.toString();
        const timeMatch = output.match(/out_time_ms=(\d+)/);

        if (!timeMatch || durationSeconds <= 0) {
          return;
        }

        const currentSeconds = parseInt(timeMatch[1], 10) / 1000000;
        const progress = Math.min(
          99,
          Math.round((currentSeconds / durationSeconds) * 100),
        );

        onProgress(progress);
      });

      ffmpeg.stderr.on("data", (data: Buffer) => {
        const message = data.toString();
        logger.debug({ jobId, ffmpeg: message.trim() }, "FFmpeg output");
        stderrOutput += message;
        this.writeLogLine(logPath, message);
      });

      ffmpeg.on("close", (code) => {
        const exitLine = `\n[${new Date().toISOString()}] FFmpeg exited with code ${code}\n`;
        this.writeLogLine(logPath, exitLine);

        if (code === 0) {
          resolve({
            command,
            durationMs: Date.now() - startedAt,
            ffmpegOutput: stderrOutput,
          });
          return;
        }

        const ffmpegError = new Error(
          `FFmpeg exited with code ${code}. ${stderrOutput.slice(-500).trim()}`,
        ) as Error & { stderrOutput?: string; code?: number | null };
        ffmpegError.stderrOutput = stderrOutput;
        ffmpegError.code = code;
        reject(ffmpegError);
      });

      ffmpeg.on("error", (error) => {
        reject(new InternalServerError(`FFmpeg error: ${error.message}`));
      });
    });
  }

  private shouldRetryWithFallback(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    const stderrOutput = (error as Error & { stderrOutput?: string })
      .stderrOutput;
    const combinedOutput =
      `${error.message}\n${stderrOutput ?? ""}`.toLowerCase();

    return (
      combinedOutput.includes(
        "reconfiguring filter graph because hwaccel changed",
      ) ||
      combinedOutput.includes(
        "reconfiguring filter graph because video parameters changed",
      ) ||
      combinedOutput.includes("impossible to convert between the formats") ||
      combinedOutput.includes("error reinitializing filters") ||
      combinedOutput.includes("parsed_scale_vaapi")
    );
  }

  private stringifyCommand(binary: string, args: string[]): string {
    const escapedArgs = args.map((arg) => {
      if (/^[A-Za-z0-9_./:-]+$/.test(arg)) {
        return arg;
      }

      return `'${arg.replace(/'/g, `'"'"'`)}'`;
    });

    return [binary, ...escapedArgs].join(" ");
  }

  /**
   * Calculate target bitrate based on video and preset — public for reuse
   */
  calculateTargetBitrate(
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
    encodingMode: EncodingMode = "hw",
  ): string[] {
    if (encodingMode === "full_sw") {
      const swCodec = this.getSoftwareCodec(preset.codec);
      switch (swCodec) {
        case "libsvtav1":
          // SVT-AV1 CRF mode (--rc 0): must NOT combine with -b:v/-maxrate
          return ["-crf", preset.qp.toString(), "-preset", "6"];

        case "libx265":
          // x265 CRF: -b:v overrides CRF, so omit bitrate constraints
          return ["-crf", preset.qp.toString(), "-preset", "medium"];

        case "libx264":
          // x264 CRF: similarly, omit -b:v; adjust CRF slightly vs VAAPI QP
          return [
            "-crf",
            (preset.qp - 3).toString(),
            "-preset",
            "medium",
            "-profile:v",
            "high",
          ];

        default:
          return ["-crf", preset.qp.toString()];
      }
    }

    const baseOptions = ["-async_depth", "64"];

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
          "-global_quality:v",
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
        return ["-global_quality:v", preset.qp.toString()];
    }
  }

  /**
   * Get max bitrate for resolution and codec — public for reuse
   */
  getMaxRate(width: number, codec: "av1" | "hevc" | "h264"): string {
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
   * Get buffer size (typically 2x maxrate) — public for reuse
   */
  getBufSize(maxRate: string): string {
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

    const isPortrait = height > width;
    const target = preset.targetWidth;

    if (isPortrait) {
      if (height <= target) {
        return "original";
      }
      return `-2x${target}`;
    }

    // If video is smaller than target width, keep original
    if (width <= target) {
      return "original";
    }

    // Target width with auto height (aspect ratio preserved)
    return `${target}x-2`;
  }
}

export const ffmpegService = new FfmpegService();
