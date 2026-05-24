import { db } from "@/config/drizzle";
import { appSettingsTable } from "@/database/schema";
import type { AppSetting, SettingValue } from "./settings.types";

const DEFAULT_SETTINGS: Record<string, SettingValue> = {
  min_watch_seconds: 60,
  short_video_watch_seconds: 10,
  short_video_duration_seconds: 60,
  downscale_inactive_days: 90,
  watch_session_gap_minutes: 30,
  max_suggestions: 200,
};

export class SettingsService {
  private cache: Map<string, SettingValue> | null = null;
  private initPromise: Promise<void> | null = null;

  private async init(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._loadAndEnsureDefaults();
    return this.initPromise;
  }

  private async _loadAndEnsureDefaults(): Promise<void> {
    await db
      .insert(appSettingsTable)
      .values(
        Object.entries(DEFAULT_SETTINGS).map(([key, value]) => ({
          key,
          value: String(value),
        })),
      )
      .onConflictDoNothing();

    const rows = await db.query.appSettingsTable.findMany();
    this.cache = new Map(
      rows.map((row) => [row.key, this.parseSettingValue(row.key, row.value)]),
    );
  }

  private invalidateCache(): void {
    this.cache = null;
    this.initPromise = null;
  }

  private parseSettingValue(key: string, value: string): SettingValue {
    if (value === "true") return true;
    if (value === "false") return false;

    const numberValue = Number(value);
    if (!Number.isNaN(numberValue) && value.trim() !== "") {
      return numberValue;
    }

    if (Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key)) {
      return DEFAULT_SETTINGS[key];
    }

    return value;
  }

  async getAll(): Promise<AppSetting[]> {
    await this.init();
    const rows = await db.query.appSettingsTable.findMany({
      orderBy: (settings, { asc }) => [asc(settings.key)],
    });

    return rows.map((row) => ({
      key: row.key,
      value: this.parseSettingValue(row.key, row.value),
      updated_at: row.updatedAt.toISOString(),
    }));
  }

  async getValue(key: string): Promise<SettingValue> {
    await this.init();

    if (this.cache!.has(key)) {
      return this.cache!.get(key)!;
    }

    const defaultValue = Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key)
      ? DEFAULT_SETTINGS[key]
      : "";
    this.cache!.set(key, defaultValue);
    return defaultValue;
  }

  async getNumber(key: string): Promise<number> {
    const value = await this.getValue(key);
    if (typeof value === "number") return value;

    const numberValue = Number(value);
    if (!Number.isNaN(numberValue)) {
      return numberValue;
    }

    const fallback = DEFAULT_SETTINGS[key];
    return typeof fallback === "number" ? fallback : 0;
  }

  async updateValues(
    values: Record<string, SettingValue>,
  ): Promise<AppSetting[]> {
    const entries = Object.entries(values);
    if (entries.length === 0) return this.getAll();

    await db.transaction(async (tx) => {
      for (const [key, value] of entries) {
        await tx
          .insert(appSettingsTable)
          .values({
            key,
            value: String(value),
          })
          .onConflictDoUpdate({
            target: appSettingsTable.key,
            set: {
              value: String(value),
              updatedAt: new Date(),
            },
          });
      }
    });

    this.invalidateCache();
    return this.getAll();
  }
}

export const settingsService = new SettingsService();
export { DEFAULT_SETTINGS };
