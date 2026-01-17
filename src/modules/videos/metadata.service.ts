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

// Set ffmpeg and ffprobe paths
ffmpeg.setFfmpegPath(env.FFMPEG_PATH);
ffmpeg.setFfprobePath(env.FFPROBE_PATH);

export class MetadataService {
  async extractMetadata(filePath: string): Promise<VideoMetadata> {
    const startTime = Date.now();

    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(filePath, (err, metadata) => {
        const duration = Date.now() - startTime;

        if (err) {
          logger.error(
            { filePath, error: err, durationMs: duration },
            `ffprobe failed after ${duration}ms`,
          );
          return reject(err);
        }

        try {
          const videoStream = metadata.streams.find(
            (s: any) => s.codec_type === "video",
          );
          const audioStream = metadata.streams.find(
            (s: any) => s.codec_type === "audio",
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
            `ffprobe completed in ${duration}ms`,
          );

          resolve(result);
        } catch (error) {
          logger.error(
            { filePath, error, durationMs: duration },
            `Metadata parsing failed after ${duration}ms`,
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
