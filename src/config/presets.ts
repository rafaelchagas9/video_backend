/**
 * Video conversion presets optimized for file size while maintaining quality
 * All outputs use MKV container format
 * Aspect ratio is always preserved (no cropping/distortion)
 */

export type CodecType = "h264_vaapi" | "hevc_vaapi" | "av1_vaapi";
export type ResolutionTarget = "1080p" | "720p" | "original";

export interface ConversionPreset {
  id: string;
  name: string;
  description: string;
  targetWidth: number | null; // null = keep original
  codec: CodecType;
  qp: number; // Quality floor (lower = better quality, larger file)
  maxBitrate: string | null; // Bitrate ceiling; null = dynamic
  audioBitrate: string;
  container: "mkv";
}

/**
 * Presets organized by resolution and codec
 * Height is calculated dynamically to preserve aspect ratio
 */
export const CONVERSION_PRESETS: Record<string, ConversionPreset> = {
  // 1080p presets (target width: 1920)
  "1080p_h264": {
    id: "1080p_h264",
    name: "1080p H.264",
    description: "Full HD with H.264 - Best compatibility",
    targetWidth: 1920,
    codec: "h264_vaapi",
    qp: 26,
    maxBitrate: "20M",
    audioBitrate: "128k",
    container: "mkv",
  },
  "1080p_h265": {
    id: "1080p_h265",
    name: "1080p H.265/HEVC",
    description: "Full HD with HEVC - Good compression",
    targetWidth: 1920,
    codec: "hevc_vaapi",
    qp: 28,
    maxBitrate: "15M",
    audioBitrate: "128k",
    container: "mkv",
  },
  "1080p_av1": {
    id: "1080p_av1",
    name: "1080p AV1",
    description: "Full HD with AV1 - Best compression",
    targetWidth: 1920,
    codec: "av1_vaapi",
    qp: 38,
    maxBitrate: "6M",
    audioBitrate: "128k",
    container: "mkv",
  },

  // 720p presets (target width: 1280)
  "720p_h264": {
    id: "720p_h264",
    name: "720p H.264",
    description: "HD with H.264 - Best compatibility",
    targetWidth: 1280,
    codec: "h264_vaapi",
    qp: 26,
    maxBitrate: "10M",
    audioBitrate: "128k",
    container: "mkv",
  },
  "720p_h265": {
    id: "720p_h265",
    name: "720p H.265/HEVC",
    description: "HD with HEVC - Good compression",
    targetWidth: 1280,
    codec: "hevc_vaapi",
    qp: 28,
    maxBitrate: "8M",
    audioBitrate: "128k",
    container: "mkv",
  },
  "720p_av1": {
    id: "720p_av1",
    name: "720p AV1",
    description: "HD with AV1 - Best compression",
    targetWidth: 1280,
    codec: "av1_vaapi",
    qp: 35,
    maxBitrate: "4M",
    audioBitrate: "128k",
    container: "mkv",
  },

  // Original resolution presets (keep source resolution)
  original_h264: {
    id: "original_h264",
    name: "Original H.264",
    description: "Keep resolution with H.264 - Best compatibility",
    targetWidth: null,
    codec: "h264_vaapi",
    qp: 26,
    maxBitrate: null,
    audioBitrate: "128k",
    container: "mkv",
  },
  original_h265: {
    id: "original_h265",
    name: "Original H.265/HEVC",
    description: "Keep resolution with HEVC - Good compression",
    targetWidth: null,
    codec: "hevc_vaapi",
    qp: 28,
    maxBitrate: null,
    audioBitrate: "128k",
    container: "mkv",
  },
  original_av1: {
    id: "original_av1",
    name: "Original AV1",
    description: "Keep resolution with AV1 - Best compression",
    targetWidth: null,
    codec: "av1_vaapi",
    qp: 35,
    maxBitrate: null,
    audioBitrate: "128k",
    container: "mkv",
  },
} as const;

/**
 * Get preset by ID
 */
export function getPreset(presetId: string): ConversionPreset | undefined {
  return CONVERSION_PRESETS[presetId];
}

/**
 * List all available presets
 */
export function listPresets(): ConversionPreset[] {
  return Object.values(CONVERSION_PRESETS);
}

/**
 * Minimum height threshold for 720p target
 * Videos with height below this will keep original resolution
 */
export const MIN_HEIGHT_FOR_720P = 720;
