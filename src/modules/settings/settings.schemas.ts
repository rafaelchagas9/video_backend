import { z } from "zod";

export { updateSettingsSchema } from "./settings.types";

const settingValueSchema = z.union([z.string(), z.number(), z.boolean()]);

const settingSchema = z.object({
  key: z.string(),
  value: settingValueSchema,
  updated_at: z.string(),
});

const errorSchema = z.object({
  message: z.string(),
  statusCode: z.number(),
});

export const settingsResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(settingSchema),
});

export const errorResponseSchema = z.object({
  success: z.literal(false),
  error: errorSchema,
});
