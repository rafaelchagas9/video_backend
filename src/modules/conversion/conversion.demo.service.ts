/**
 * Synthetic conversion history for demo mode.
 *
 * The real history table is tied to the personal library, so demo mode cannot
 * expose it. Without a stand-in the whole history/insights UI renders as an
 * empty state and cannot be reviewed. This generates a deterministic dataset
 * with a realistic spread of source characteristics and outcomes.
 */
import { CONVERSION_PRESETS } from "@/config/presets";
import { conversionInsightsService } from "./conversion.insights.service";
import type {
  ConversionHistoryFilters,
  ConversionHistoryListOptions,
  ConversionHistoryListResult,
  ConversionHistoryOverview,
  ConversionHistoryRecord,
  ConversionInsights,
} from "./conversion.types";
import { RESOLUTION_BUCKETS } from "./conversion.buckets";

const DEMO_ENTRY_COUNT = 180;
const DEMO_SEED = 0x5ca1ab1e;
const DEMO_VIDEO_COUNT = 132;
const DAY_MS = 86_400_000;

interface DemoSourceProfile {
  width: number;
  height: number;
  codec: string;
  fps: number;
  /** Source bitrate range in Mbps. */
  bitrate: [number, number];
  weight: number;
}

const SOURCE_PROFILES: DemoSourceProfile[] = [
  {
    width: 3840,
    height: 2160,
    codec: "h264",
    fps: 30,
    bitrate: [28, 48],
    weight: 8,
  },
  {
    width: 2560,
    height: 1440,
    codec: "h264",
    fps: 60,
    bitrate: [16, 28],
    weight: 8,
  },
  {
    width: 1920,
    height: 1080,
    codec: "h264",
    fps: 30,
    bitrate: [7, 16],
    weight: 34,
  },
  {
    width: 1920,
    height: 1080,
    codec: "h264",
    fps: 60,
    bitrate: [10, 20],
    weight: 12,
  },
  {
    width: 1920,
    height: 1080,
    codec: "hevc",
    fps: 30,
    bitrate: [4, 8],
    weight: 10,
  },
  {
    width: 1920,
    height: 1080,
    codec: "vp9",
    fps: 30,
    bitrate: [3, 6],
    weight: 6,
  },
  {
    width: 1080,
    height: 1920,
    codec: "h264",
    fps: 30,
    bitrate: [9, 18],
    weight: 8,
  },
  {
    width: 1280,
    height: 720,
    codec: "h264",
    fps: 30,
    bitrate: [2, 5],
    weight: 10,
  },
  {
    width: 1920,
    height: 1080,
    codec: "av1",
    fps: 24,
    bitrate: [3, 5],
    weight: 4,
  },
];

const DEMO_PRESETS = ["1080p_av1", "original_av1", "1080p_h265"] as const;

/** Deterministic PRNG so demo output is stable across restarts. */
function mulberry32(seed: number) {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class ConversionDemoService {
  private cache: ConversionHistoryRecord[] | null = null;

  private get entries(): ConversionHistoryRecord[] {
    if (!this.cache) {
      this.cache = this.generate();
    }

    return this.cache;
  }

  list(
    options: ConversionHistoryListOptions = {},
  ): ConversionHistoryListResult {
    const limit = Math.min(options.limit ?? 50, 200);
    const offset = options.offset ?? 0;
    const filtered = this.applyFilters(this.entries, options);
    const sorted = this.applySort(filtered, options);

    return {
      items: sorted.slice(offset, offset + limit),
      total: filtered.length,
      limit,
      offset,
    };
  }

  overview(filters: ConversionHistoryFilters = {}): ConversionHistoryOverview {
    const rows = this.applyFilters(this.entries, filters);
    const sum = (select: (row: ConversionHistoryRecord) => number) =>
      rows.reduce((total, row) => total + select(row), 0);

    const durations = rows
      .map((row) => row.conversion_duration_ms)
      .filter((value): value is number => value !== null);

    return {
      total_conversions: rows.length,
      total_original_size_bytes: sum((row) => row.original_size_bytes),
      total_output_size_bytes: sum((row) => row.output_size_bytes),
      total_size_delta_bytes: sum((row) => row.size_delta_bytes),
      total_saved_bytes: sum((row) =>
        row.size_delta_bytes < 0 ? -row.size_delta_bytes : 0,
      ),
      total_increased_bytes: sum((row) =>
        row.size_delta_bytes > 0 ? row.size_delta_bytes : 0,
      ),
      saved_count: rows.filter((row) => row.size_delta_bytes < 0).length,
      increased_count: rows.filter((row) => row.size_delta_bytes > 0).length,
      unchanged_count: rows.filter((row) => row.size_delta_bytes === 0).length,
      avg_size_change_percent: rows.length
        ? sum((row) => row.size_change_percent) / rows.length
        : 0,
      avg_conversion_duration_ms: durations.length
        ? Math.round(
            durations.reduce((total, value) => total + value, 0) /
              durations.length,
          )
        : 0,
    };
  }

  insights(filters: ConversionHistoryFilters = {}): ConversionInsights {
    return conversionInsightsService.analyze(
      this.applyFilters(this.entries, filters),
    );
  }

  presets(): string[] {
    return Array.from(new Set(this.entries.map((row) => row.preset))).sort();
  }

  sourceCodecs(): string[] {
    return Array.from(
      new Set(
        this.entries
          .map((row) => row.source_codec)
          .filter((codec): codec is string => Boolean(codec)),
      ),
    ).sort();
  }

  private generate(): ConversionHistoryRecord[] {
    const random = mulberry32(DEMO_SEED);
    const totalWeight = SOURCE_PROFILES.reduce(
      (total, profile) => total + profile.weight,
      0,
    );
    const now = Date.now();
    const entries: ConversionHistoryRecord[] = [];

    for (let index = 0; index < DEMO_ENTRY_COUNT; index += 1) {
      const profile = this.pickProfile(random() * totalWeight);
      const preset =
        DEMO_PRESETS[random() < 0.82 ? 0 : random() < 0.6 ? 1 : 2] ??
        DEMO_PRESETS[0];
      const presetConfig = CONVERSION_PRESETS[preset];

      const durationSeconds = Math.round(240 + random() * 2700);
      const sourceMbps =
        profile.bitrate[0] +
        random() * (profile.bitrate[1] - profile.bitrate[0]);
      const originalSizeBytes = Math.round(
        (sourceMbps * 1_000_000 * durationSeconds) / 8,
      );

      const longEdge = Math.max(profile.width, profile.height);
      const targetWidth = presetConfig?.targetWidth ?? null;
      const willDownscale = targetWidth !== null && longEdge > targetWidth;
      const scale = willDownscale ? targetWidth / longEdge : 1;

      const outputWidth = Math.round((profile.width * scale) / 2) * 2;
      const outputHeight = Math.round((profile.height * scale) / 2) * 2;

      // Mirrors profile version 2: preserve the source total bitrate when it is
      // below the cap, reserving 96 kbps for Opus audio.
      const ceilingMbps = presetConfig?.maxBitrate
        ? Number.parseInt(presetConfig.maxBitrate.replace("M", ""), 10)
        : 6;
      const encoderTarget = Math.min(
        ceilingMbps,
        Math.max(0.1, sourceMbps - 0.096),
      );
      let outputMbps = (encoderTarget + 0.096) * (0.88 + random() * 0.24);

      if (profile.codec === "av1" || profile.codec === "hevc") {
        // Already-efficient sources have little redundancy left to squeeze.
        outputMbps = Math.max(
          outputMbps,
          sourceMbps * (0.92 + random() * 0.16),
        );
      }
      const outputSizeBytes = Math.round(
        (outputMbps * 1_000_000 * durationSeconds) / 8,
      );

      const sizeDeltaBytes = outputSizeBytes - originalSizeBytes;
      const conversionDurationMs = Math.round(
        (durationSeconds / (8 + random() * 12)) * 1000,
      );

      const createdAt = new Date(
        now - Math.round(random() * 150 * DAY_MS) - index * 900_000,
      );
      const startedAt = new Date(createdAt.getTime() - conversionDurationMs);
      const videoId = ((index * 7) % DEMO_VIDEO_COUNT) + 1;
      const label = `Demo ${String(videoId).padStart(3, "0")}`;

      entries.push({
        id: index + 1,
        conversion_job_id: 10_000 + index,
        video_id: index % 9 === 0 ? null : videoId,
        source_video_deleted: index % 9 === 0,
        source_file_path: `/demo/library/${label}.mp4`,
        source_file_name: `${label} - Sample Clip.mp4`,
        output_file_path: `/demo/converted/${label}.mkv`,
        preset,
        codec: presetConfig?.codec ?? "av1_vaapi",
        target_resolution: willDownscale ? `${targetWidth}x-2` : "original",
        ffmpeg_command: `ffmpeg -i /demo/library/${label}.mp4 -c:v ${presetConfig?.codec ?? "av1_vaapi"} /demo/converted/${label}.mkv`,
        original_size_bytes: originalSizeBytes,
        output_size_bytes: outputSizeBytes,
        size_delta_bytes: sizeDeltaBytes,
        size_change_percent: (sizeDeltaBytes / originalSizeBytes) * 100,
        conversion_duration_ms: conversionDurationMs,
        duration_seconds: durationSeconds,
        source_width: profile.width,
        source_height: profile.height,
        source_fps: profile.fps,
        source_codec: profile.codec,
        source_audio_codec: random() < 0.7 ? "aac" : "opus",
        source_bitrate: Math.round(sourceMbps * 1_000_000),
        output_width: outputWidth,
        output_height: outputHeight,
        output_fps: profile.fps,
        output_codec: (presetConfig?.codec ?? "av1_vaapi").replace(
          "_vaapi",
          "",
        ),
        output_audio_codec: "opus",
        output_bitrate: Math.round(outputMbps * 1_000_000),
        profile_version: 2,
        planned_video_bitrate: Math.round(encoderTarget * 1_000_000),
        planned_max_bitrate: Math.round(
          Math.min(ceilingMbps, encoderTarget * 1.2) * 1_000_000,
        ),
        planned_qp: presetConfig?.qp ?? 35,
        effective_resolution: `${outputWidth}x${outputHeight}`,
        encoding_mode: "hw",
        encode_speed_ratio: durationSeconds / (conversionDurationMs / 1000),
        started_at: startedAt.toISOString(),
        completed_at: createdAt.toISOString(),
        created_at: createdAt.toISOString(),
      });
    }

    return entries.sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  private pickProfile(target: number): DemoSourceProfile {
    let cursor = 0;

    for (const profile of SOURCE_PROFILES) {
      cursor += profile.weight;
      if (target <= cursor) {
        return profile;
      }
    }

    return SOURCE_PROFILES[SOURCE_PROFILES.length - 1]!;
  }

  private applyFilters(
    rows: ConversionHistoryRecord[],
    filters: ConversionHistoryFilters,
  ): ConversionHistoryRecord[] {
    const presets = filters.presets?.length
      ? filters.presets
      : filters.preset
        ? [filters.preset]
        : [];

    const resolutionBucket = filters.resolution
      ? RESOLUTION_BUCKETS.find((bucket) => bucket.key === filters.resolution)
      : undefined;

    return rows.filter((row) => {
      if (filters.videoId !== undefined && row.video_id !== filters.videoId) {
        return false;
      }

      if (presets.length > 0 && !presets.includes(row.preset)) {
        return false;
      }

      if (filters.sourceCodec && row.source_codec !== filters.sourceCodec) {
        return false;
      }

      if (resolutionBucket) {
        const longEdge = Math.max(
          row.source_width ?? 0,
          row.source_height ?? 0,
        );
        if (
          longEdge < resolutionBucket.minLongEdge ||
          (resolutionBucket.maxLongEdge !== null &&
            longEdge >= resolutionBucket.maxLongEdge)
        ) {
          return false;
        }
      }

      if (filters.outcome === "saved" && row.size_delta_bytes >= 0)
        return false;
      if (filters.outcome === "increased" && row.size_delta_bytes <= 0)
        return false;
      if (filters.outcome === "unchanged" && row.size_delta_bytes !== 0)
        return false;

      if (
        filters.search &&
        !row.source_file_name
          .toLowerCase()
          .includes(filters.search.toLowerCase())
      ) {
        return false;
      }

      if (filters.createdAfter && row.created_at < filters.createdAfter) {
        return false;
      }

      if (filters.createdBefore && row.created_at > filters.createdBefore) {
        return false;
      }

      if (
        filters.minSizeChangePercent !== undefined &&
        row.size_change_percent < filters.minSizeChangePercent
      ) {
        return false;
      }

      if (
        filters.maxSizeChangePercent !== undefined &&
        row.size_change_percent > filters.maxSizeChangePercent
      ) {
        return false;
      }

      if (
        filters.minSourceBitrate !== undefined &&
        (row.source_bitrate ?? 0) < filters.minSourceBitrate
      ) {
        return false;
      }

      if (
        filters.maxSourceBitrate !== undefined &&
        (row.source_bitrate ?? Number.MAX_SAFE_INTEGER) >
          filters.maxSourceBitrate
      ) {
        return false;
      }

      return true;
    });
  }

  private applySort(
    rows: ConversionHistoryRecord[],
    options: ConversionHistoryListOptions,
  ): ConversionHistoryRecord[] {
    const field = options.sortBy ?? "created_at";
    const direction = options.sortDir === "asc" ? 1 : -1;

    const value = (row: ConversionHistoryRecord): number | null => {
      switch (field) {
        case "created_at":
          return Date.parse(row.created_at);
        case "completed_at":
          return row.completed_at ? Date.parse(row.completed_at) : null;
        case "size_change_percent":
          return row.size_change_percent;
        case "size_delta_bytes":
          return row.size_delta_bytes;
        case "original_size_bytes":
          return row.original_size_bytes;
        case "output_size_bytes":
          return row.output_size_bytes;
        case "conversion_duration_ms":
          return row.conversion_duration_ms;
        case "source_bitrate":
          return row.source_bitrate;
        case "duration_seconds":
          return row.duration_seconds;
        default:
          return null;
      }
    };

    return [...rows].sort((a, b) => {
      const left = value(a);
      const right = value(b);

      if (left === null && right === null) return 0;
      if (left === null) return 1;
      if (right === null) return -1;

      return (left - right) * direction;
    });
  }
}

export const conversionDemoService = new ConversionDemoService();
