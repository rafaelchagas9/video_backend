import { z } from "zod";

export const editJobStatusSchema = z.enum([
  "pending",
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

export const timelineSegmentSchema = z.object({
  start: z.number().min(0),
  end: z.number().min(0),
  speed: z.number().min(0.1).max(10).optional().default(1.0),
});

export const editOutputConfigSchema = z.object({
  directory_id: z.number().int().positive(),
  file_name: z.string().min(1),
  format: z.literal("mkv").default("mkv"),
  video_codec: z.literal("av1").default("av1"),
  audio_codec: z.literal("copy").or(z.literal("aac")).default("copy"),
  preserve: z
    .object({
      resolution: z.boolean().optional(),
      bitrate: z.boolean().optional(),
      frame_rate: z.boolean().optional(),
    })
    .optional(),
});

export const createEditJobBodySchema = z.object({
  output: editOutputConfigSchema,
  timeline: z.object({
    snap_to_clips: z.boolean().optional(),
    segments: z.array(timelineSegmentSchema).min(1),
  }),
});

export const editJobResponseSchema = z.object({
  success: z.boolean(),
  data: z.object({
    job_id: z.number(),
    status: editJobStatusSchema,
    video_id: z.number(),
    output: z.object({
      directory_id: z.number(),
      file_name: z.string(),
    }),
  }),
  message: z.string().optional(),
});

export const outputDirectoriesResponseSchema = z.object({
  success: z.boolean(),
  data: z.array(
    z.object({
      id: z.number(),
      path: z.string(),
      label: z.string(),
      video_count: z.number().optional(),
      last_scan_at: z.string().nullable().optional(),
    }),
  ),
});

export const editingMetadataResponseSchema = z.object({
  success: z.boolean(),
  data: z.object({
    id: z.number(),
    title: z.string().nullable(),
    duration: z.number().nullable(),
    fps: z.number().nullable(),
    resolution: z.object({
      width: z.number().nullable(),
      height: z.number().nullable(),
    }),
    bitrate: z.number().nullable(),
    audio: z.object({
      channels: z.number().nullable(),
      sample_rate: z.number().nullable(),
    }),
    storyboard_vtt: z.string().nullable(),
  }),
});

export const jobStatusResponseSchema = z.object({
  success: z.boolean(),
  data: z.object({
    job_id: z.number(),
    status: editJobStatusSchema,
    progress: z.number().optional(),
    started_at: z.string().nullable().optional(),
    completed_at: z.string().nullable().optional(),
    output: z
      .object({
        directory_id: z.number().optional(),
        video_id: z.number().nullable().optional(),
        file_name: z.string().optional(),
        stream_url: z.string().optional(),
      })
      .optional(),
    error: z
      .object({
        code: z.string(),
        message: z.string(),
      })
      .optional(),
  }),
});
