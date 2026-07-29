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

export interface FfmpegRunResult {
  command: string;
  durationMs: number;
  ffmpegOutput: string;
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
