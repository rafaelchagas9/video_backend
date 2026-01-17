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
  delete_original: boolean;
  batch_id: string | null;
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
 * WebSocket event types for conversion notifications
 */
export type ConversionEventType = 
  | 'conversion:started'
  | 'conversion:progress'
  | 'conversion:completed'
  | 'conversion:failed'
  | 'conversion:batch_completed';

export interface ConversionEvent {
  type: ConversionEventType;
  message: {
    jobId: number;
    videoId: number;
    preset: string;
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
