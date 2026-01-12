import { getDatabase } from "@/config/database";
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
  private get db() {
    return getDatabase();
  }

  private ensureDefaults(): void {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO app_settings (key, value, updated_at)
       VALUES (?, ?, datetime('now'))`,
    );

    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      insert.run(key, String(value));
    }
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
    this.ensureDefaults();

    const rows = this.db
      .prepare(
        "SELECT key, value, updated_at FROM app_settings ORDER BY key ASC",
      )
      .all() as {
      key: string;
      value: string;
      updated_at: string;
    }[];

    return rows.map((row) => ({
      key: row.key,
      value: this.parseSettingValue(row.key, row.value),
      updated_at: row.updated_at,
    }));
  }

  async getValue(key: string): Promise<SettingValue> {
    this.ensureDefaults();

    const row = this.db
      .prepare("SELECT key, value FROM app_settings WHERE key = ?")
      .get(key) as { key: string; value: string } | undefined;

    if (!row) {
      const defaultValue = Object.prototype.hasOwnProperty.call(
        DEFAULT_SETTINGS,
        key,
      )
        ? DEFAULT_SETTINGS[key]
        : "";
      this.db
        .prepare(
          `INSERT OR IGNORE INTO app_settings (key, value, updated_at)
           VALUES (?, ?, datetime('now'))`,
        )
        .run(key, String(defaultValue));
      return defaultValue;
    }

    return this.parseSettingValue(row.key, row.value);
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
    this.ensureDefaults();

    const entries = Object.entries(values);
    if (entries.length === 0) return this.getAll();

    const update = this.db.transaction(() => {
      const stmt = this.db.prepare(
        `INSERT INTO app_settings (key, value, updated_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = datetime('now')`,
      );

      for (const [key, value] of entries) {
        stmt.run(key, String(value));
      }
    });

    update();

    return this.getAll();
  }
}

export const settingsService = new SettingsService();
export { DEFAULT_SETTINGS };
