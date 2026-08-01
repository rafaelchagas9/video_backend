import { getDemoSqlite, withDemoTransaction } from "@/database/demo";
import { DEFAULT_SETTINGS } from "./settings.defaults";
import type { AppSetting, SettingValue } from "./settings.types";

const DEMO_TIMESTAMP = "2026-01-01T12:00:00.000Z";

interface SettingRow {
  key: string;
  value_json: string;
  updated_at: string;
}

/** Persistent settings isolated to demo_settings in the demo SQLite file. */
export class SettingsDemoService {
  async getAll(): Promise<AppSetting[]> {
    const stored = new Map(
      getDemoSqlite()
        .query<SettingRow, []>(
          "SELECT key, value_json, updated_at FROM demo_settings ORDER BY key"
        )
        .all()
        .map((row) => [
          row.key,
          {
            key: row.key,
            value: JSON.parse(row.value_json) as SettingValue,
            updated_at: row.updated_at,
          },
        ])
    );

    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      if (!stored.has(key)) {
        stored.set(key, { key, value, updated_at: DEMO_TIMESTAMP });
      }
    }
    return [...stored.values()].sort((a, b) => a.key.localeCompare(b.key));
  }

  async getValue(key: string): Promise<SettingValue> {
    const row = getDemoSqlite()
      .query<
        { value_json: string },
        [string]
      >("SELECT value_json FROM demo_settings WHERE key = ?")
      .get(key);
    if (row) return JSON.parse(row.value_json) as SettingValue;
    return DEFAULT_SETTINGS[key] ?? "";
  }

  async getNumber(key: string): Promise<number> {
    const value = await this.getValue(key);
    const parsed = typeof value === "number" ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  async updateValues(
    values: Record<string, SettingValue>
  ): Promise<AppSetting[]> {
    withDemoTransaction(() => {
      const statement = getDemoSqlite().query<void, [string, string, string]>(
        `INSERT INTO demo_settings (key, value_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_at = excluded.updated_at`
      );
      for (const [key, value] of Object.entries(values)) {
        statement.run(key, JSON.stringify(value), DEMO_TIMESTAMP);
      }
    });
    return this.getAll();
  }
}

export const settingsDemoService = new SettingsDemoService();
