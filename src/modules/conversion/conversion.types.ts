/**
 * Type definitions for video conversion jobs
 */

export type JobStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';

export interface ConversionJob {
  id: number;
  video_id: number;
  status: JobStatus;
  preset: string;
  target_resolution: string | null;
  codec: string;
  output_path: string | null;
  output_size_bytes: number | null;
  progress_percent: number;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface CreateConversionJobInput {
  video_id: number;
  preset: string;
}

export interface ConversionJobWithVideo extends ConversionJob {
  video_file_name: string;
  video_file_path: string;
  video_width: number | null;
  video_height: number | null;
}

/**
 * WebSocket event types for conversion notifications
 */
export type ConversionEventType = 
  | 'conversion:started'
  | 'conversion:progress'
  | 'conversion:completed'
  | 'conversion:failed';

export interface ConversionEvent {
  type: ConversionEventType;
  jobId: number;
  videoId: number;
  preset: string;
  progress?: number;
  outputPath?: string;
  error?: string;
}

/**
 * Queue job payload stored in Redis
 */
export interface QueueJobPayload {
  jobId: number;
  videoId: number;
  preset: string;
  inputPath: string;
  outputPath: string;
  createdAt: string;
}
