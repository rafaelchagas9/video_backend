import { z } from "zod";
import { perceptualCatalogResultsSchema } from "@/modules/perceptual-duplicates/perceptual-catalog.schemas";

export const librarySyncTaskSchema = z.enum([
  "perceptual",
  "faces",
  "storyboards",
  "previews",
]);
export const librarySyncStartBodySchema = z
  .object({
    tasks: z
      .array(librarySyncTaskSchema)
      .min(1)
      .max(4)
      .refine(
        (items) => new Set(items).size === items.length,
        "Tasks must be unique"
      ),
  })
  .strict();
export const librarySyncSettingsBodySchema = z
  .object({ auto_perceptual: z.boolean() })
  .strict();
export const librarySyncRunIdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});
export const librarySyncResultsQuerySchema = z.object({
  view: z.enum(["copies", "similarity"]).default("copies"),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().nonnegative().default(0),
});

const publicErrorSchema = z
  .object({ code: z.string(), message: z.string() })
  .nullable();
const taskProgressSchema = z.object({
  total: z.number().int(),
  processed: z.number().int(),
  completed: z.number().int(),
  failed: z.number().int(),
  skipped: z.number().int(),
  pending: z.number().int(),
});
const runSchema = z.object({
  id: z.number().int(),
  generation: z.string().nullable(),
  tasks: z.array(librarySyncTaskSchema),
  trigger: z.enum(["manual", "automatic"]),
  status: z.enum([
    "queued",
    "running",
    "retry_wait",
    "completed",
    "failed",
    "cancelled",
  ]),
  phase: z.enum([
    "queued",
    "scanning",
    "executing",
    "completed",
    "failed",
    "cancelled",
  ]),
  progress: z.object({
    total: z.number().int(),
    processed: z.number().int(),
    completed: z.number().int(),
    failed: z.number().int(),
    skipped: z.number().int(),
    pending: z.number().int(),
    current: z
      .object({ task: librarySyncTaskSchema, video_id: z.number().int() })
      .nullable(),
    by_task: z.object({
      perceptual: taskProgressSchema,
      faces: taskProgressSchema,
      storyboards: taskProgressSchema,
      previews: taskProgressSchema,
    }),
  }),
  recent_items: z.array(
    z.object({
      task: librarySyncTaskSchema,
      video_id: z.number().int(),
      status: z.enum(["completed", "failed", "skipped"]),
      result: z.record(z.string(), z.unknown()).nullable(),
      error: publicErrorSchema,
    })
  ),
  error: publicErrorSchema,
  retry_count: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  cancelled_at: z.string().nullable(),
});
export const librarySyncRunResponseSchema = z.object({
  success: z.literal(true),
  data: runSchema,
});
export const librarySyncStartedResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({ run: runSchema, reused: z.boolean() }),
});
export const librarySyncSettingsResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({ auto_perceptual: z.boolean() }),
});
export const librarySyncOverviewResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    generation: z.string(),
    capabilities: z.object({
      perceptual: z.object({
        enabled: z.boolean(),
        code: z.literal("COPY_ENGINE_NOT_READY").nullable(),
        reason: z.string().nullable(),
      }),
    }),
    settings: z.object({ auto_perceptual: z.boolean() }),
    counts: z.object({
      total_videos: z.number().int(),
      tasks: z.object({
        perceptual: z.object({
          pending: z.number().int(),
          completed: z.number().int(),
        }),
        faces: z.object({
          pending: z.number().int(),
          completed: z.number().int(),
        }),
        storyboards: z.object({
          pending: z.number().int(),
          completed: z.number().int(),
        }),
        previews: z.object({
          pending: z.number().int(),
          completed: z.number().int(),
        }),
      }),
    }),
    active_run: runSchema.nullable(),
    recent_runs: z.array(runSchema),
  }),
});
export const librarySyncPerceptualResultsResponseSchema = z.object({
  success: z.literal(true),
  data: perceptualCatalogResultsSchema,
});
