/**
 * Type definitions for video conversion jobs
 */

export type JobStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed"
  | "cancelled";

export interface ConversionJob {
  id: number;
  video_id: number;
  status: JobStatus;
  preset: string;
  target_resolution: string | null;
  codec: string;
  delete_original: boolean;
  batch_id: string | null;
  output_path: string | null;
  output_size_bytes: number | null;
  progress_percent: number;
  error_message: string | null;
  ffmpeg_output: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface CreateConversionJobInput {
  video_id: number;
  preset: string;
  deleteOriginal?: boolean;
  batchId?: string;
}

export interface ConversionJobWithVideo extends ConversionJob {
  video_file_name: string;
  video_file_path: string;
  video_width: number | null;
  video_height: number | null;
}

/**
 * Real-time event types for conversion notifications
 */
export type ConversionEventType =
  | "conversion:started"
  | "conversion:progress"
  | "conversion:completed"
  | "conversion:failed"
  | "conversion:batch_completed";

export interface ConversionEvent {
  type: ConversionEventType;
  message: {
    jobId: number;
    videoId: number;
    video_id?: number;
    videoTitle?: string;
    video_title?: string;
    fileName?: string;
    file_name?: string;
    preset: string;
    batchId?: string;
    progress?: number;
    outputPath?: string;
    error?: string;
    stats?: {
      total: number;
      completed: number;
      failed: number;
    };
  };
}

/**
 * Queue job payload stored in Redis
 */
export interface QueueJobPayload {
  jobId: number;
  videoId: number;
  preset: string;
  deleteOriginal?: boolean;
  batchId?: string;
  inputPath: string;
  outputPath: string;
  createdAt: string;
}

export type ConversionEncodingMode = "hw" | "sw_decode" | "full_sw";

export interface FfmpegRunResult {
  command: string;
  durationMs: number;
  ffmpegOutput: string;
  encodingMode: ConversionEncodingMode;
  profileVersion: number;
  plannedVideoBitrate: number;
  plannedMaxBitrate: number;
  plannedQp: number;
}

/**
 * Technical metadata for one side (source or output) of a conversion.
 * Every field is nullable: ffprobe can fail, and rows written before these
 * columns existed are backfilled on a best-effort basis.
 */
export interface ConversionMediaMetadata {
  width: number | null;
  height: number | null;
  fps: number | null;
  codec: string | null;
  audioCodec: string | null;
  bitrate: number | null;
  durationSeconds: number | null;
}

export interface ConversionHistoryRecord {
  id: number;
  conversion_job_id: number | null;
  video_id: number | null;
  source_video_deleted: boolean;
  source_file_path: string;
  source_file_name: string;
  output_file_path: string;
  preset: string;
  codec: string;
  target_resolution: string | null;
  ffmpeg_command: string;
  original_size_bytes: number;
  output_size_bytes: number;
  size_delta_bytes: number;
  size_change_percent: number;
  conversion_duration_ms: number | null;
  duration_seconds: number | null;
  source_width: number | null;
  source_height: number | null;
  source_fps: number | null;
  source_codec: string | null;
  source_audio_codec: string | null;
  source_bitrate: number | null;
  output_width: number | null;
  output_height: number | null;
  output_fps: number | null;
  output_codec: string | null;
  output_audio_codec: string | null;
  output_bitrate: number | null;
  profile_version: number | null;
  planned_video_bitrate: number | null;
  planned_max_bitrate: number | null;
  planned_qp: number | null;
  effective_resolution: string | null;
  encoding_mode: ConversionEncodingMode | null;
  /** Media seconds encoded per wall-clock second. Null when either is unknown. */
  encode_speed_ratio: number | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface ConversionHistoryEntry {
  conversionJobId: number;
  videoId: number;
  sourceFilePath: string;
  sourceFileName: string;
  outputFilePath: string;
  preset: string;
  codec: string;
  targetResolution: string | null;
  ffmpegCommand: string;
  originalSizeBytes: number;
  outputSizeBytes: number;
  conversionDurationMs: number | null;
  sourceMetadata: ConversionMediaMetadata | null;
  outputMetadata: ConversionMediaMetadata | null;
  profileVersion: number;
  plannedVideoBitrate: number;
  plannedMaxBitrate: number;
  plannedQp: number;
  effectiveResolution: string | null;
  encodingMode: ConversionEncodingMode;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface ConversionHistoryOverview {
  total_conversions: number;
  total_original_size_bytes: number;
  total_output_size_bytes: number;
  total_size_delta_bytes: number;
  total_saved_bytes: number;
  total_increased_bytes: number;
  saved_count: number;
  increased_count: number;
  unchanged_count: number;
  avg_size_change_percent: number;
  avg_conversion_duration_ms: number;
}

export type ConversionHistorySortField =
  | "created_at"
  | "completed_at"
  | "size_change_percent"
  | "size_delta_bytes"
  | "original_size_bytes"
  | "output_size_bytes"
  | "conversion_duration_ms"
  | "source_bitrate"
  | "duration_seconds";

export type ConversionHistorySortDirection = "asc" | "desc";

export type ConversionOutcome = "saved" | "increased" | "unchanged";

export interface ConversionHistoryFilters {
  videoId?: number;
  preset?: string;
  presets?: string[];
  sourceCodec?: string;
  resolution?: string;
  outcome?: ConversionOutcome;
  search?: string;
  createdAfter?: string;
  createdBefore?: string;
  minSizeChangePercent?: number;
  maxSizeChangePercent?: number;
  minSourceBitrate?: number;
  maxSourceBitrate?: number;
}

export interface ConversionHistoryListOptions extends ConversionHistoryFilters {
  limit?: number;
  offset?: number;
  sortBy?: ConversionHistorySortField;
  sortDir?: ConversionHistorySortDirection;
}

export interface ConversionHistoryListResult {
  items: ConversionHistoryRecord[];
  total: number;
  limit: number;
  offset: number;
}

/** Aggregated outcome for one slice of the history (a preset, a bitrate band, …). */
export interface ConversionInsightGroup {
  key: string;
  label: string;
  conversions: number;
  total_original_size_bytes: number;
  total_output_size_bytes: number;
  total_saved_bytes: number;
  total_increased_bytes: number;
  increased_count: number;
  avg_size_change_percent: number;
  median_size_change_percent: number;
  avg_source_bitrate: number | null;
  avg_output_bitrate: number | null;
  avg_conversion_duration_ms: number | null;
  avg_encode_speed_ratio: number | null;
}

export interface ConversionInsightTimelinePoint {
  period: string;
  conversions: number;
  total_original_size_bytes: number;
  total_output_size_bytes: number;
  total_saved_bytes: number;
  avg_size_change_percent: number;
}

export interface ConversionInsightBreakEven {
  resolution_key: string;
  resolution_label: string;
  /** Median bitrate the encoder actually lands on, in bits per second. */
  typical_output_bitrate: number | null;
  /** Lowest source bitrate (bps) above which conversions reliably shrink. */
  crossover_bitrate: number | null;
  below_count: number;
  below_avg_size_change_percent: number | null;
  below_wasted_bytes: number;
  above_count: number;
  above_avg_size_change_percent: number | null;
  above_saved_bytes: number;
}

export type ConversionInsightSeverity = "critical" | "warning" | "info";

export interface ConversionInsightRecommendation {
  id: string;
  severity: ConversionInsightSeverity;
  title: string;
  detail: string;
  metric: string | null;
}

export interface ConversionInsightCoverage {
  total_conversions: number;
  analyzed: number;
  with_duration: number;
  with_source_bitrate: number;
  with_source_resolution: number;
  with_source_codec: number;
}

export interface ConversionInsightExtreme {
  id: number;
  preset: string;
  profile_version: number | null;
  effective_resolution: string | null;
  source_bitrate: number | null;
  output_bitrate: number | null;
  original_size_bytes: number;
  output_size_bytes: number;
  size_delta_bytes: number;
  size_change_percent: number;
  conversion_duration_ms: number | null;
  created_at: string;
}

export interface ConversionInsights {
  coverage: ConversionInsightCoverage;
  by_preset: ConversionInsightGroup[];
  by_source_bitrate: ConversionInsightGroup[];
  by_source_resolution: ConversionInsightGroup[];
  by_source_codec: ConversionInsightGroup[];
  by_source_fps: ConversionInsightGroup[];
  by_month: ConversionInsightTimelinePoint[];
  break_even: ConversionInsightBreakEven[];
  best: ConversionInsightExtreme[];
  worst: ConversionInsightExtreme[];
  recommendations: ConversionInsightRecommendation[];
}
