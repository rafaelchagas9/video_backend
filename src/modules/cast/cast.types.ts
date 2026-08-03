export const CAST_TRANSCODE_PROFILES = [
  "original-hevc",
  "1080p-hevc",
  "720p-hevc",
  "1080p-h264",
  "720p-h264",
] as const;

export type CastTranscodeProfile = (typeof CAST_TRANSCODE_PROFILES)[number];
export type CastVideoCodec = "hevc" | "h264";
export type CastEncodingMode = "hardware" | "software-decode" | "software";
export type CastSessionState = "starting" | "ready" | "completed" | "failed";

export interface CastProfileConfig {
  id: CastTranscodeProfile;
  label: string;
  codec: CastVideoCodec;
  maxWidth: number | null;
  bitrate: string;
  maxrate: string;
  bufsize: string;
  qp: number;
}

export interface CastSessionStatus {
  id: string;
  video_id: number;
  profile: CastTranscodeProfile;
  profile_label: string;
  video_codec: CastVideoCodec;
  content_type: "application/x-mpegURL";
  manifest_url: string;
  state: CastSessionState;
  encoding_mode: CastEncodingMode;
  size_bytes: number;
  generated_duration_seconds: number;
  duration_seconds: number | null;
  progress_percent: number | null;
  expires_at: string;
  error_message?: string;
}
