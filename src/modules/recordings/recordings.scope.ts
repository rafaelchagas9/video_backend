import { sql } from "drizzle-orm";
import { db } from "@/config/drizzle";
import { env } from "@/config/env";
import { settingsService } from "@/modules/settings/settings.service";

/**
 * Which library videos are GoondVR recordings, and where clips go. Shared by the
 * recordings module and the library's "hide recordings" filter.
 */
/** The demo has one folder for everything: there, recordings are its long videos. */
export const DEMO_RECORDING_MIN_SECONDS = 900;

export interface RecordingScope {
  directoryId: number | null;
  clipsDirectoryId: number | null;
  /** Set only in the demo; real libraries keep GoondVR's output in a folder of its own. */
  minDurationSeconds: number | null;
}

export async function recordingDirectories(): Promise<{ id: number; path: string; count: number }[]> {
  if (env.DEMO_MODE) return [{ id: 1, path: "demo_mode/video", count: 132 }];
  const rows = await db.execute<{ id: number; path: string; count: number }>(sql`
    SELECT d.id, d.path, count(v.id)::int AS count FROM watched_directories d
    LEFT JOIN videos v ON v.directory_id = d.id GROUP BY d.id ORDER BY count DESC`);
  return rows.map((row) => ({ id: Number(row.id), path: String(row.path), count: Number(row.count) }));
}

export async function recordingScope(): Promise<RecordingScope> {
  const [directoryId, all] = await Promise.all([settingsService.getNumber("recordings_directory_id"), recordingDirectories()]);
  // Detect GoondVR's output folder by name until one is chosen explicitly.
  const recordings =
    (directoryId ? all.find((dir) => dir.id === directoryId) : undefined) ??
    all.find((dir) => /goondvr/i.test(dir.path)) ??
    (env.DEMO_MODE ? all[0] : undefined);
  const clips = all.find((dir) => dir.id !== recordings?.id) ?? recordings;
  return {
    directoryId: recordings?.id ?? null,
    clipsDirectoryId: clips?.id ?? null,
    minDurationSeconds: env.DEMO_MODE ? DEMO_RECORDING_MIN_SECONDS : null,
  };
}
