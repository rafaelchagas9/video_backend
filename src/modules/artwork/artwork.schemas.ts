import { z } from "zod";
import { ARTWORK_EFFECTS, ARTWORK_VARIANTS } from "./artwork.types";

export const artworkVariantSchema = z.enum(ARTWORK_VARIANTS);
export const artworkEffectSchema = z.enum(ARTWORK_EFFECTS);

export const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export const generateArtworkSchema = z.object({
  variants: z.array(artworkVariantSchema).min(1).max(5).optional(),
  force: z.boolean().default(false),
  timestamp_seconds: z.number().min(0).optional(),
  effects: z.array(artworkEffectSchema).max(4).optional(),
});

export const batchGenerateArtworkSchema = z
  .object({
    video_ids: z.array(z.number().int().positive()).min(1).max(1000).optional(),
    filter: z
      .object({
        collection_id: z.number().int().positive().optional(),
        creator_id: z.number().int().positive().optional(),
        missing_only: z.boolean().optional(),
      })
      .optional(),
    variants: z.array(artworkVariantSchema).min(1).max(5).optional(),
    force: z.boolean().default(false),
  })
  .refine((value) => Boolean(value.video_ids || value.filter), {
    message: "Provide video_ids or filter",
  })
  .refine((value) => !(value.video_ids && value.filter), {
    message: "Provide video_ids or filter, not both",
  });

export const artworkImageQuerySchema = z.object({
  w: z.coerce.number().int().positive().max(4096).optional(),
  format: z.enum(["webp", "avif", "jpg", "png"]).optional(),
  h: z.string().regex(/^[a-f0-9]{16}$/).optional(),
});

const pointSchema = z.object({ x: z.number(), y: z.number() });
const rectSchema = pointSchema.extend({ width: z.number(), height: z.number() });
const paletteSchema = z.object({
  dominant: z.string(),
  swatches: z.array(z.string()),
  mean_oklch: z.object({ l: z.number(), c: z.number(), h: z.number() }),
  is_neutral: z.boolean(),
});

const artworkAssetSchema = z.object({
  id: z.number(),
  video_id: z.number(),
  variant: artworkVariantSchema,
  url: z.string(),
  width: z.number(),
  height: z.number(),
  file_size_bytes: z.number(),
  source_timestamp_seconds: z.number().nullable(),
  crop: rectSchema.nullable(),
  focal_point: pointSchema.nullable(),
  safe_area: rectSchema.nullable(),
  bottom_luma: z.number().nullable(),
  thumbhash: z.string().nullable(),
  effects: z.array(artworkEffectSchema),
  generated_at: z.string(),
});

export const videoArtworkSchema = z.object({
  video_id: z.number(),
  status: z.enum(["ready", "generating", "failed", "absent"]),
  palette: paletteSchema.nullable(),
  assets: z.array(artworkAssetSchema),
  error: z.string().nullable(),
  generated_at: z.string().nullable(),
});

export const videoArtworkResponseSchema = z.object({
  success: z.literal(true),
  data: videoArtworkSchema,
});

export const batchArtworkResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    queued: z.number(),
    video_ids: z.array(z.number()),
  }),
});

export const messageResponseSchema = z.object({
  success: z.literal(true),
  message: z.string(),
});

export const errorResponseSchema = z.object({
  success: z.literal(false),
  error: z.object({ message: z.string(), statusCode: z.number() }),
});

export const artworkSummarySchema = z.object({
  urls: z
    .object({
      card: z.string(),
      poster: z.string(),
      square: z.string(),
      hero: z.string(),
      title: z.string(),
    })
    .partial(),
  palette: paletteSchema.nullable(),
  focal_point: pointSchema.nullable(),
  safe_area: rectSchema.nullable(),
  bottom_luma: z.number().nullable(),
  thumbhash: z.string().nullable(),
});
