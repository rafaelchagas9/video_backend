import { z } from "zod";

export type SettingValue = string | number | boolean;

export interface AppSetting {
  key: string;
  value: SettingValue;
  updated_at: string;
}

export const updateSettingsSchema = z.object({
  settings: z.record(
    z.string(),
    z.union([z.string(), z.number(), z.boolean()]),
  ),
});

export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;
