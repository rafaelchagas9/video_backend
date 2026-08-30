import { z } from "zod";

const categoryIdsSchema = z
  .array(z.number().int().positive())
  .refine((ids) => new Set(ids).size === ids.length, {
    message: "category_ids must not contain duplicates",
  });

const bookmarkIntervalFields = {
  timestamp_seconds: z.number().finite().min(0),
  end_timestamp_seconds: z.number().finite().min(0).optional(),
  peak_timestamp_seconds: z.number().finite().min(0).optional(),
};

export const createBookmarkSchema = z
  .object({
    ...bookmarkIntervalFields,
    name: z.string().trim().min(1).max(255),
    description: z.string().max(2000).optional(),
    category_ids: categoryIdsSchema.optional(),
  })
  .strict()
  .superRefine((bookmark, context) => {
    const hasEnd = bookmark.end_timestamp_seconds !== undefined;
    const hasPeak = bookmark.peak_timestamp_seconds !== undefined;
    if (hasEnd !== hasPeak) {
      context.addIssue({
        code: "custom",
        message:
          "end_timestamp_seconds and peak_timestamp_seconds must be provided together",
      });
      return;
    }
    if (
      hasEnd &&
      (bookmark.timestamp_seconds > bookmark.peak_timestamp_seconds! ||
        bookmark.peak_timestamp_seconds! > bookmark.end_timestamp_seconds!)
    ) {
      context.addIssue({
        code: "custom",
        message: "Bookmark timestamps must satisfy start <= peak <= end",
      });
    }
  });

export const updateBookmarkSchema = z
  .object({
    timestamp_seconds: z.number().finite().min(0).optional(),
    end_timestamp_seconds: z.number().finite().min(0).nullable().optional(),
    peak_timestamp_seconds: z.number().finite().min(0).nullable().optional(),
    name: z.string().trim().min(1).max(255).optional(),
    description: z.string().max(2000).nullable().optional(),
    category_ids: categoryIdsSchema.optional(),
  })
  .strict();

export const bookmarkListQuerySchema = z.object({
  origin: z.enum(["manual", "automatic"]).optional(),
  category: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/)
    .optional(),
});

export const createBookmarkCategorySchema = z
  .object({
    key: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
    name: z.string().trim().min(1).max(255),
  })
  .strict();

export const updateBookmarkCategorySchema = z
  .object({ name: z.string().trim().min(1).max(255) })
  .strict();

export const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export const bookmarkCategoryAssignmentSchema = z.object({
  id: z.number(),
  key: z.string(),
  name: z.string(),
  kind: z.enum(["system", "custom"]),
  confidence: z.number().min(0).max(1).nullable(),
  provider_label: z.string().nullable(),
});

export const bookmarkCategorySchema = z.object({
  id: z.number(),
  key: z.string(),
  name: z.string(),
  kind: z.enum(["system", "custom"]),
  user_id: z.number().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const bookmarkSchema = z.object({
  id: z.number(),
  video_id: z.number(),
  user_id: z.number(),
  timestamp_seconds: z.number(),
  end_timestamp_seconds: z.number().nullable(),
  peak_timestamp_seconds: z.number().nullable(),
  origin: z.enum(["manual", "automatic"]),
  analysis_run_id: z.number().nullable(),
  user_modified_at: z.string().nullable(),
  is_user_edited: z.boolean(),
  name: z.string(),
  description: z.string().nullable(),
  categories: z.array(bookmarkCategoryAssignmentSchema),
  created_at: z.string(),
  updated_at: z.string(),
});

const errorSchema = z.object({
  message: z.string(),
  statusCode: z.number(),
});

export const bookmarkResponseSchema = z.object({
  success: z.literal(true),
  data: bookmarkSchema,
  message: z.string().optional(),
});

export const bookmarksResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(bookmarkSchema),
});

export const bookmarkCreatedResponseSchema = bookmarkResponseSchema;

export const bookmarkCategoryResponseSchema = z.object({
  success: z.literal(true),
  data: bookmarkCategorySchema,
  message: z.string().optional(),
});

export const bookmarkCategoriesResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(bookmarkCategorySchema),
});

export const messageResponseSchema = z.object({
  success: z.literal(true),
  message: z.string(),
});

export const errorResponseSchema = z.object({
  success: z.literal(false),
  error: errorSchema,
});
