export type EditJobStatus =
  | "pending"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface TimelineSegment {
  start: number; // seconds
  end: number; // seconds
  speed?: number; // default 1.0
  /** Effects applied to this segment before timeline concatenation. */
  transform?: EditTransformConfig;
  /** Audio effects applied to this segment before timeline concatenation. */
  audio?: EditAudioConfig;
}

export interface EditCropTransform {
  /** Normalized horizontal origin (0-1). */
  x: number;
  /** Normalized vertical origin (0-1). */
  y: number;
  /** Normalized crop width (0-1). */
  width: number;
  /** Normalized crop height (0-1). */
  height: number;
}

export interface EditTransformConfig {
  crop?: EditCropTransform;
  rotate?: 0 | 90 | 180 | 270;
}

export interface EditAudioConfig {
  muted?: boolean;
  volume?: number;
  fade_in_seconds?: number;
  fade_out_seconds?: number;
}

export interface EditTimelineConfig {
  segments: TimelineSegment[];
  transform?: EditTransformConfig;
  audio?: EditAudioConfig;
}

export interface EditOutputConfig {
  directory_id: number;
  file_name: string;
  format: "mkv";
  video_codec: "av1";
  audio_codec: "opus" | "aac";
}

export interface EditJob {
  id: number;
  videoId: number;
  status: EditJobStatus;
  progress: number;
  outputConfig: EditOutputConfig;
  timelineConfig: EditTimelineConfig;
  outputPath: string | null;
  outputVideoId: number | null;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface CreateEditJobInput {
  output: EditOutputConfig;
  timeline: EditTimelineConfig;
}

export interface EditRecipe {
  source_video_id: number;
  output_defaults: Omit<EditOutputConfig, "file_name">;
  timeline: EditTimelineConfig;
}

export interface CloneEditJobInput {
  output: EditOutputConfig;
  timeline?: EditTimelineConfig;
}

export interface EditQueuePayload {
  jobId: number;
  videoId: number;
  outputConfig: EditOutputConfig;
  timelineConfig: EditTimelineConfig;
}

export interface EditJobListOptions {
  page: number;
  limit: number;
  videoId?: number;
  status?: EditJobStatus;
}

export interface EditJobListResult {
  data: EditJob[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}
