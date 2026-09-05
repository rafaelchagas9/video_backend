import { spawn } from "node:child_process";
import ffmpeg from "fluent-ffmpeg";
import { env } from "@/config/env";
import { logger } from "@/utils/logger";
import type { VideoMetadata } from "./videos.types";

const parseNullableNumber = (value: unknown): number | null => {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number.parseFloat(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
};

// Other media services still use fluent-ffmpeg's shared executable configuration.
ffmpeg.setFfmpegPath(env.FFMPEG_PATH);
ffmpeg.setFfprobePath(env.FFPROBE_PATH);

export class MetadataService {
  constructor(private readonly probeTimeoutMs = 30_000) {}

  async extractMetadata(
    filePath: string,
    signal?: AbortSignal
  ): Promise<VideoMetadata> {
    if (signal?.aborted) throw new Error("Metadata inspection cancelled");
    const startTime = Date.now();

    return new Promise((resolve, reject) => {
      const child = spawn(
        env.FFPROBE_PATH,
        [
          "-v",
          "error",
          "-show_entries",
          "stream=codec_type,width,height,codec_name,r_frame_rate,avg_frame_rate:format=duration,bit_rate",
          "-of",
          "json",
          filePath,
        ],
        { stdio: ["ignore", "pipe", "pipe"] }
      );
      let output = "";
      let failure: Error | undefined;
      const stop = (message: string) => {
        failure ??= new Error(message);
        if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
      };
      const abort = () => stop("Metadata inspection cancelled");
      const timeout = setTimeout(
        () => stop("Metadata inspection timed out"),
        this.probeTimeoutMs
      );
      timeout.unref();
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      child.stdout.on("data", (chunk: Buffer) => {
        if (failure) return;
        output += chunk.toString();
        if (output.length > 1_048_576)
          stop("Metadata inspection output is too large");
      });
      child.stderr.resume();
      child.on("error", () => {
        failure ??= new Error("Metadata inspection could not start");
      });
      child.on("close", (code) => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        const duration = Date.now() - startTime;

        if (failure || code !== 0) {
          const error = failure ?? new Error("Metadata inspection failed");
          logger.error(
            { filePath, error, durationMs: duration },
            `ffprobe failed after ${duration}ms`
          );
          return reject(error);
        }

        try {
          const metadata = JSON.parse(output);
          const videoStream = metadata.streams.find(
            (s: any) => s.codec_type === "video"
          );
          const audioStream = metadata.streams.find(
            (s: any) => s.codec_type === "audio"
          );

          const result: VideoMetadata = {
            duration_seconds: parseNullableNumber(metadata.format.duration),
            width: videoStream?.width || null,
            height: videoStream?.height || null,
            codec: videoStream?.codec_name || null,
            bitrate: metadata.format.bit_rate
              ? parseInt(metadata.format.bit_rate.toString())
              : null,
            fps: this.extractFps(videoStream),
            audio_codec: audioStream?.codec_name || null,
          };

          logger.debug(
            {
              filePath,
              durationMs: duration,
              metadata: {
                duration: result.duration_seconds,
                resolution: `${result.width}x${result.height}`,
                codec: result.codec,
              },
            },
            `ffprobe completed in ${duration}ms`
          );

          resolve(result);
        } catch (error) {
          logger.error(
            { filePath, error, durationMs: duration },
            `Metadata parsing failed after ${duration}ms`
          );
          reject(error);
        }
      });
    });
  }

  private extractFps(stream: any): number | null {
    if (!stream) return null;

    try {
      // Try r_frame_rate first (more accurate)
      if (stream.r_frame_rate) {
        const [num, den] = stream.r_frame_rate.split("/").map(Number);
        if (den && num) {
          return parseFloat((num / den).toFixed(2));
        }
      }

      // Fallback to avg_frame_rate
      if (stream.avg_frame_rate) {
        const [num, den] = stream.avg_frame_rate.split("/").map(Number);
        if (den && num) {
          return parseFloat((num / den).toFixed(2));
        }
      }

      return null;
    } catch {
      return null;
    }
  }
}

export const metadataService = new MetadataService();
