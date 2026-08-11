import { z } from "zod";

export const editJobStatusSchema = z.enum([
  "pending",
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

export const normalizedCropSchema = z
  .object({
    x: z.number().finite().min(0).max(1),
    y: z.number().finite().min(0).max(1),
    width: z.number().finite().positive().max(1),
    height: z.number().finite().positive().max(1),
  })
  .strict()
  .superRefine((crop, context) => {
    if (crop.x + crop.width > 1) {
      context.addIssue({
        code: "custom",
        message: "Crop x + width must be at most 1",
        path: ["width"],
      });
    }
    if (crop.y + crop.height > 1) {
      context.addIssue({
        code: "custom",
        message: "Crop y + height must be at most 1",
        path: ["height"],
      });
    }
  });

export const editTransformSchema = z
  .object({
    crop: normalizedCropSchema.optional(),
    rotate: z
      .union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)])
      .optional(),
  })
  .strict();

export const editAudioSchema = z
  .object({
    muted: z.boolean().optional().default(false),
    volume: z.number().finite().min(0).max(4).optional().default(1),
    fade_in_seconds: z.number().finite().min(0).optional().default(0),
    fade_out_seconds: z.number().finite().min(0).optional().default(0),
  })
  .strict();

export const timelineSegmentSchema = z
  .object({
    start: z.number().finite().min(0),
    end: z.number().finite().min(0),
    speed: z.number().finite().min(0.1).max(10).optional().default(1),
    transform: editTransformSchema.optional(),
    audio: editAudioSchema.optional(),
  })
  .strict()
  .refine((segment) => segment.end > segment.start, {
    message: "Segment end must be greater than start",
    path: ["end"],
  })
  .superRefine((segment, context) => {
    const editedDuration = (segment.end - segment.start) / (segment.speed ?? 1);
    for (const field of ["fade_in_seconds", "fade_out_seconds"] as const) {
      const value = segment.audio?.[field];
      if (value !== undefined && value > editedDuration) {
        context.addIssue({
          code: "custom",
          message: `Segment audio ${field} must fit within the edited segment duration`,
          path: ["audio", field],
        });
      }
    }
  });

const safeOutputFileNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .regex(/^[^/\\]+$/, "File name must be a basename without separators")
  .refine(
    (name) =>
      !Array.from(name).some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 31 || codePoint === 127;
      }),
    { message: "File name must not contain control characters" }
  )
  .refine((name) => name !== "." && name !== "..", {
    message: "File name must not be a traversal component",
  });

export const editOutputConfigSchema = z
  .object({
    directory_id: z.number().int().positive(),
    file_name: safeOutputFileNameSchema,
    format: z.literal("mkv").optional().default("mkv"),
    video_codec: z.literal("av1").optional().default("av1"),
    audio_codec: z.enum(["opus", "aac"]).optional().default("opus"),
  })
  .strict();

export const createEditJobBodySchema = z
  .object({
    output: editOutputConfigSchema,
    timeline: z
      .object({
        segments: z.array(timelineSegmentSchema).min(1),
        transform: editTransformSchema.optional(),
        audio: editAudioSchema.optional(),
      })
      .strict(),
  })
  .strict();

export const listEditJobsQuerySchema = z
  .object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(20),
    video_id: z.coerce.number().int().positive().optional(),
    status: editJobStatusSchema.optional(),
  })
  .strict();

export const editJobResponseSchema = z.object({
  success: z.literal(true),
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
  success: z.literal(true),
  data: z.array(
    z.object({
      id: z.number(),
      path: z.string(),
      label: z.string(),
      video_count: z.number().optional(),
      last_scan_at: z.string().nullable().optional(),
    })
  ),
});

export const editingCapabilities = {
  timeline: {
    trim: true as const,
    split: true as const,
    reorder: true as const,
    single_source_only: true as const,
    speed: { min: 0.1 as const, max: 10 as const },
    segment_effects: {
      transform: {
        crop: "normalized" as const,
        rotate: [0, 90, 180, 270] as [0, 90, 180, 270],
      },
      audio: {
        mute: true as const,
        volume: { min: 0 as const, max: 4 as const },
        fades: true as const,
      },
    },
  },
  transform: {
    crop: "normalized" as const,
    rotate: [0, 90, 180, 270] as [0, 90, 180, 270],
  },
  audio: {
    mute: true as const,
    volume: { min: 0 as const, max: 4 as const },
    fades: true as const,
  },
  output: {
    formats: ["mkv"] as ["mkv"],
    video_codecs: ["av1"] as ["av1"],
    audio_codecs: ["opus", "aac"] as ["opus", "aac"],
  },
  unsupported: [
    "multi_source_timeline",
    "transitions",
    "text_overlays",
    "subtitle_editing",
    "audio_mixing",
  ],
};

export const editingMetadataResponseSchema = z.object({
  success: z.literal(true),
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
      present: z.boolean(),
      codec: z.string().nullable(),
      channels: z.number().nullable(),
      sample_rate: z.number().nullable(),
    }),
    storyboard_vtt: z.string().nullable(),
    capabilities: z.object({
      timeline: z.object({
        trim: z.literal(true),
        split: z.literal(true),
        reorder: z.literal(true),
        single_source_only: z.literal(true),
        speed: z.object({ min: z.literal(0.1), max: z.literal(10) }),
        segment_effects: z.object({
          transform: z.object({
            crop: z.literal("normalized"),
            rotate: z.tuple([
              z.literal(0),
              z.literal(90),
              z.literal(180),
              z.literal(270),
            ]),
          }),
          audio: z.object({
            mute: z.literal(true),
            volume: z.object({ min: z.literal(0), max: z.literal(4) }),
            fades: z.literal(true),
          }),
        }),
      }),
      transform: z.object({
        crop: z.literal("normalized"),
        rotate: z.tuple([
          z.literal(0),
          z.literal(90),
          z.literal(180),
          z.literal(270),
        ]),
      }),
      audio: z.object({
        mute: z.literal(true),
        volume: z.object({ min: z.literal(0), max: z.literal(4) }),
        fades: z.literal(true),
      }),
      output: z.object({
        formats: z.tuple([z.literal("mkv")]),
        video_codecs: z.tuple([z.literal("av1")]),
        audio_codecs: z.tuple([z.literal("opus"), z.literal("aac")]),
      }),
      unsupported: z.array(z.string()),
    }),
  }),
});

const jobOutputSchema = z.object({
  directory_id: z.number(),
  video_id: z.number().nullable().optional(),
  file_name: z.string(),
  stream_url: z.string().optional(),
});

const jobErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
});

export const jobStatusDataSchema = z.object({
  job_id: z.number(),
  status: editJobStatusSchema,
  progress: z.number().min(0).max(100),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  output: jobOutputSchema.optional(),
  error: jobErrorSchema.optional(),
});

export const jobStatusResponseSchema = z.object({
  success: z.literal(true),
  data: jobStatusDataSchema,
});

export const editJobListItemSchema = jobStatusDataSchema.extend({
  video_id: z.number(),
  created_at: z.string(),
});

export const editJobListResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(editJobListItemSchema),
  pagination: z.object({
    page: z.number(),
    limit: z.number(),
    total: z.number(),
    totalPages: z.number(),
  }),
});

export const cancelEditJobResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    job_id: z.number(),
    status: editJobStatusSchema,
  }),
});

export const editErrorResponseSchema = z.object({
  success: z.literal(false),
  error: z.object({
    message: z.string(),
    statusCode: z.number(),
  }),
});
