import { runMediaProcess } from "@/utils/media-process";
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

export class MetadataService {
  constructor(private readonly probeTimeoutMs = 30_000) {}

  async extractMetadata(
    filePath: string,
    signal?: AbortSignal
  ): Promise<VideoMetadata> {
    if (signal?.aborted) throw new Error("Metadata inspection cancelled");
    const startTime = Date.now();

    try {
      const { stdout } = await runMediaProcess(
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
        { label: "Metadata inspection", timeoutMs: this.probeTimeoutMs, signal }
      );
      const duration = Date.now() - startTime;
      const metadata = JSON.parse(stdout);
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
      return result;
    } catch (error) {
      logger.error(
        { filePath, error, durationMs: Date.now() - startTime },
        "Metadata inspection failed"
      );
      throw error;
    }
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
