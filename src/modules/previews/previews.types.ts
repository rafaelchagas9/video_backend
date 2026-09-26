export interface VideoPreview {
  video_id: number;
  file_size_bytes: number;
  duration_seconds: number;
  clip_count: number;
  width: number;
  height: number;
  has_audio: boolean;
  generated_at: string;
}

export interface PreviewGenerationStatus {
  video_id: number;
  status: "idle" | "queued" | "processing" | "ready" | "failed";
  updated_at: string | null;
  error?: string;
}
