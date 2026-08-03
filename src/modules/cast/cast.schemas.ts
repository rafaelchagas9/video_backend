import { z } from "zod";
import { CAST_TRANSCODE_PROFILES } from "./cast.types";

export const castVideoParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export const castSessionParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
  sessionId: z.string().regex(/^[a-f0-9]{64}$/),
});

export const castPlaybackParamsSchema = z.object({
  token: z.string().regex(/^[a-f0-9]{64}$/),
  asset: z
    .string()
    .regex(
      /^(?:master\.m3u8|index\.m3u8|init\.mp4|segment-\d{6}\.(?:m4s|ts))$/
    ),
});

export const createCastSessionSchema = z.object({
  profile: z.enum(CAST_TRANSCODE_PROFILES).default("original-hevc"),
  request_key: z.string().trim().min(1).max(200).optional(),
  start_time_seconds: z.number().finite().min(0).default(0),
});

export const castSessionStatusSchema = z.object({
  id: z.string(),
  video_id: z.number(),
  profile: z.enum(CAST_TRANSCODE_PROFILES),
  profile_label: z.string(),
  video_codec: z.enum(["hevc", "h264"]),
  content_type: z.literal("application/x-mpegURL"),
  manifest_url: z.string(),
  state: z.enum(["starting", "ready", "completed", "failed"]),
  encoding_mode: z.enum(["hardware", "software-decode", "software"]),
  size_bytes: z.number(),
  generated_duration_seconds: z.number(),
  duration_seconds: z.number().nullable(),
  progress_percent: z.number().nullable(),
  expires_at: z.string(),
  error_message: z.string().optional(),
});

export const castSessionResponseSchema = z.object({
  success: z.literal(true),
  data: castSessionStatusSchema,
});

export const castSessionDeletedResponseSchema = z.object({
  success: z.literal(true),
  message: z.string(),
});

export const castErrorResponseSchema = z.object({
  success: z.literal(false),
  error: z.object({
    message: z.string(),
    statusCode: z.number(),
  }),
});
