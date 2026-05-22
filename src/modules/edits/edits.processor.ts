import { join } from "path";
import { existsSync, renameSync, mkdirSync } from "fs";
import { spawn } from "child_process";
import { editsService } from "./edits.service";
import { editsQueue } from "./edits.queue";
import { videosService } from "@/modules/videos/videos.service";
import { directoriesService } from "@/modules/directories/directories.service";
import { ffmpegService } from "@/modules/conversion/conversion.ffmpeg.service";
import { logger } from "@/utils/logger";
import { recordPerfStage } from "@/utils/performance-profiler";
import { env } from "@/config/env";
import type { EditQueuePayload, TimelineSegment } from "./edits.types";
import type { Video } from "@/modules/videos/videos.types";

export class EditsProcessor {
  constructor() {
    // Register processor with queue
    editsQueue.setProcessor(this.processJob.bind(this));
  }

  async processJob(payload: EditQueuePayload): Promise<void> {
    const { jobId, videoId, outputConfig, timelineConfig } = payload;
    const totalStart = Date.now();
    logger.info({ jobId }, "Starting edit job processing");

    try {
      // Update status to running
      await editsService.updateStatus(jobId, "running");

      // 1. Get source video
      const sourceVideo = await videosService.findById(videoId);
      if (!existsSync(sourceVideo.file_path)) {
        throw new Error(`Source file not found: ${sourceVideo.file_path}`);
      }

      // 2. Prepare output path
      const prepareStart = Date.now();
      const outputDir = await directoriesService.findById(
        outputConfig.directory_id,
      );
      const outputFilename = outputConfig.file_name.endsWith(".mkv")
        ? outputConfig.file_name
        : `${outputConfig.file_name}.mkv`;

      const tempDir = join(outputDir.path, ".temp_edits");
      if (!existsSync(tempDir)) mkdirSync(tempDir, { recursive: true });

      const tempOutputPath = join(tempDir, `edit_${jobId}_${outputFilename}`);
      const finalOutputPath = join(outputDir.path, outputFilename);

      await recordPerfStage(
        { scenario: "editing", videoId, jobId, mode: "process_job" },
        "prepare_paths",
        Date.now() - prepareStart,
        { segmentCount: timelineConfig.segments.length },
      );

      // 3. Build and run FFmpeg command with VAAPI GPU acceleration
      const ffmpegStart = Date.now();
      await this.runFfmpeg(
        jobId,
        sourceVideo,
        tempOutputPath,
        timelineConfig.segments,
      );
      await recordPerfStage(
        { scenario: "editing", videoId, jobId, mode: "process_job" },
        "ffmpeg_encode",
        Date.now() - ffmpegStart,
        { segmentCount: timelineConfig.segments.length },
      );

      // 4. Move file to final location
      renameSync(tempOutputPath, finalOutputPath);

      await editsService.updateStatus(jobId, "completed", {
        outputPath: finalOutputPath,
        progress: 100,
      });

      await recordPerfStage(
        { scenario: "editing", videoId, jobId, mode: "process_job" },
        "total",
        Date.now() - totalStart,
        { segmentCount: timelineConfig.segments.length },
      );

      logger.info({ jobId }, "Edit job completed successfully");
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error({ jobId, error }, "Edit job failed");
      await editsService.updateStatus(jobId, "failed", {
        errorMessage,
      });
    }
  }

  /**
   * Build atempo filter chain for speeds outside 0.5-2.0 range
   * atempo only accepts values between 0.5 and 2.0, so we chain them
   */
  private buildAtempoChain(speed: number): string {
    if (speed === 1.0) return "";

    const atempos: string[] = [];
    let remaining = speed;

    if (speed > 1.0) {
      // Speed up: chain atempo=2.0 until we get close
      while (remaining > 2.0) {
        atempos.push("atempo=2.0");
        remaining /= 2.0;
      }
      if (remaining !== 1.0) {
        atempos.push(`atempo=${remaining.toFixed(6)}`);
      }
    } else {
      // Slow down: chain atempo=0.5 until we get close
      while (remaining < 0.5) {
        atempos.push("atempo=0.5");
        remaining /= 0.5;
      }
      if (remaining !== 1.0) {
        atempos.push(`atempo=${remaining.toFixed(6)}`);
      }
    }

    return atempos.length > 0 ? `,${atempos.join(",")}` : "";
  }

  /**
   * Build the complex filter graph for trimming and concatenating segments
   */
  private buildFilterComplex(segments: TimelineSegment[]): string {
    const filters: string[] = [];
    const concatInputs: string[] = [];

    segments.forEach((seg, i) => {
      const speed = seg.speed ?? 1.0;

      // Video: trim, reset PTS, then apply speed
      // CRITICAL: PTS-STARTPTS resets timestamps after trim (fixes seeking issues)
      if (speed === 1.0) {
        filters.push(
          `[0:v]trim=start=${seg.start}:end=${seg.end},setpts=PTS-STARTPTS[v${i}]`,
        );
      } else {
        filters.push(
          `[0:v]trim=start=${seg.start}:end=${seg.end},setpts=(PTS-STARTPTS)/${speed}[v${i}]`,
        );
      }

      // Audio: trim, reset PTS, then apply tempo if speed != 1
      const atempoChain = this.buildAtempoChain(speed);
      filters.push(
        `[0:a]atrim=start=${seg.start}:end=${seg.end},asetpts=PTS-STARTPTS${atempoChain}[a${i}]`,
      );

      concatInputs.push(`[v${i}][a${i}]`);
    });

    // Concat all segments
    const concatFilter = `${concatInputs.join("")}concat=n=${segments.length}:v=1:a=1[vconcat][aconcat]`;
    filters.push(concatFilter);

    // Upload to GPU for VAAPI encoding
    // hwupload converts CPU frames to VAAPI surfaces
    filters.push("[vconcat]format=nv12,hwupload[vout]");

    return filters.join(";");
  }

  /**
   * Run FFmpeg with VAAPI GPU acceleration (same as conversion module)
   */
  private runFfmpeg(
    jobId: number,
    sourceVideo: Video,
    outputPath: string,
    segments: TimelineSegment[],
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const inputPath = sourceVideo.file_path;
      const filterComplex = this.buildFilterComplex(segments);

      // Derive bitrate/quality dynamically from source video
      const sourceWidth = sourceVideo.width ?? 1920;
      const maxRate = ffmpegService.getMaxRate(sourceWidth, "av1");
      const { bitrate, maxrate, bufsize } =
        ffmpegService.calculateTargetBitrate(
          sourceVideo,
          {
            id: "edit_av1",
            name: "Edit AV1",
            description: "",
            targetWidth: null,
            codec: "av1_vaapi",
            qp: 34,
            maxBitrate: maxRate,
            audioBitrate: "96k",
            container: "mkv",
          },
          null,
        );

      // Calculate expected output duration for progress tracking
      const expectedDuration = segments.reduce((sum, seg) => {
        const segDuration = seg.end - seg.start;
        const speed = seg.speed ?? 1.0;
        return sum + segDuration / speed;
      }, 0);

      const args: string[] = [
        // Initialize VAAPI device
        "-init_hw_device",
        `vaapi=va:${env.VAAPI_DEVICE}`,
        "-filter_hw_device",
        "va",
        // Input
        "-i",
        inputPath,
        // Complex filter for trim/concat/upload
        "-filter_complex",
        filterComplex,
        // Map outputs
        "-map",
        "[vout]",
        "-map",
        "[aconcat]",
        "-fps_mode:v",
        "passthrough",
        // Video encoding: AV1 with VAAPI, dynamic bitrate
        "-c:v",
        "av1_vaapi",
        "-async_depth",
        "64",
        "-rc_mode",
        "VBR",
        "-b:v",
        bitrate,
        "-maxrate",
        maxrate,
        "-bufsize",
        bufsize,
        "-global_quality:v",
        "34",
        // Audio encoding
        "-c:a",
        "libopus",
        "-b:a",
        "96k",
        "-vbr",
        "on",
        // Output
        "-y",
        "-progress",
        "pipe:1",
        "-f",
        "matroska",
        outputPath,
      ];

      logger.info(
        { jobId, args: args.join(" ") },
        "Starting FFmpeg with VAAPI",
      );

      const ffmpeg = spawn(env.FFMPEG_PATH, args);
      let lastProgress = 0;

      ffmpeg.stdout.on("data", (data: Buffer) => {
        const output = data.toString();

        // Parse progress from FFmpeg's progress output
        const timeMatch = output.match(/out_time_ms=(\d+)/);
        if (timeMatch && expectedDuration > 0) {
          const currentSeconds = parseInt(timeMatch[1], 10) / 1_000_000;
          const progress = Math.min(
            99,
            Math.round((currentSeconds / expectedDuration) * 100),
          );

          if (progress > lastProgress + 2) {
            lastProgress = progress;
            editsService
              .updateStatus(jobId, "running", { progress })
              .catch(() => {});
          }
        }
      });

      ffmpeg.stderr.on("data", (data: Buffer) => {
        const line = data.toString().trim();
        if (line) {
          logger.debug({ jobId, ffmpeg: line }, "FFmpeg output");
        }
      });

      ffmpeg.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`FFmpeg exited with code ${code}`));
        }
      });

      ffmpeg.on("error", (error) => {
        reject(new Error(`FFmpeg error: ${error.message}`));
      });
    });
  }
}

export const editsProcessor = new EditsProcessor();
