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
}

export interface EditTimelineConfig {
  snap_to_clips?: boolean;
  segments: TimelineSegment[];
}

export interface EditOutputConfig {
  directory_id: number;
  file_name: string;
  format: string; // 'mkv'
  video_codec: string; // 'av1'
  audio_codec: string; // 'copy' | 'aac'
  preserve?: {
    resolution?: boolean;
    bitrate?: boolean;
    frame_rate?: boolean;
  };
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

export interface EditQueuePayload {
  jobId: number;
  videoId: number;
  outputConfig: EditOutputConfig;
  timelineConfig: EditTimelineConfig;
}
