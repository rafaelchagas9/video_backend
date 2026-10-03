/**
 * Library facts that discovery ranks over, read with one query per kind. The real library and
 * the demo database answer the same questions; only the SQL dialect differs.
 */
import { sql } from "drizzle-orm";
import { db } from "@/config/drizzle";
import { env } from "@/config/env";

export interface VideoFact {
  id: number;
  durationSeconds: number;
  createdAt: Date;
  creatorIds: number[];
  playCount: number;
  watchSeconds: number;
  lastWatchedAt: Date | null;
}

/** Watching per creator, including videos since deleted: taste outlives curation. */
export interface CreatorTaste {
  creatorId: number;
  name: string;
  watchSeconds: number;
  plays: number;
  lastWatchedAt: Date | null;
}

export interface BookmarkFact {
  id: number;
  videoId: number;
  start: number;
  end: number | null;
  peak: number | null;
  origin: "manual" | "automatic";
  name: string;
}

export interface LibraryFacts {
  videos: VideoFact[];
  tastes: CreatorTaste[];
}

const date = (value: unknown): Date | null => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const ids = (value: unknown): number[] => {
  if (Array.isArray(value)) return value.map(Number).filter((id) => id > 0);
  if (typeof value === "string" && value) return value.split(",").map(Number).filter((id) => id > 0);
  return [];
};

async function demoSqlite() {
  const { getDemoSqlite } = await import("@/database/demo/client");
  return getDemoSqlite();
}

export async function loadLibraryFacts(userId: number): Promise<LibraryFacts> {
  if (env.DEMO_MODE) {
    const sqlite = await demoSqlite();
    const videos = sqlite
      .query(
        `SELECT v.id, v.duration_seconds, v.created_at,
                coalesce(s.play_count, 0) AS play_count,
                coalesce(s.total_watch_seconds, 0) AS watch_seconds,
                s.last_watch_at,
                (SELECT group_concat(creator_id) FROM demo_video_creators vc WHERE vc.video_id = v.id) AS creator_ids
         FROM demo_videos v
         LEFT JOIN demo_video_stats s ON s.video_id = v.id
         WHERE v.is_available = 1`
      )
      .all() as Record<string, unknown>[];
    const tastes = sqlite
      .query(
        `SELECT c.id AS creator_id, c.name, sum(s.total_watch_seconds) AS watch_seconds,
                sum(s.play_count) AS plays, max(s.last_watch_at) AS last_watch_at
         FROM demo_video_stats s
         JOIN demo_video_creators vc ON vc.video_id = s.video_id
         JOIN demo_creators c ON c.id = vc.creator_id
         GROUP BY c.id`
      )
      .all() as Record<string, unknown>[];
    return { videos: videos.map(toVideoFact), tastes: tastes.map(toTaste) };
  }

  const [videos, tastes] = await Promise.all([
    db.execute<Record<string, unknown>>(sql`
      SELECT v.id, v.duration_seconds, v.created_at,
             coalesce(s.play_count, 0) AS play_count,
             coalesce(s.total_watch_seconds, 0) AS watch_seconds,
             s.last_watch_at,
             (SELECT array_agg(creator_id) FROM video_creators vc WHERE vc.video_id = v.id) AS creator_ids
      FROM videos v
      LEFT JOIN video_stats s ON s.video_id = v.id AND s.user_id = ${userId}
      WHERE v.is_available AND NOT v.is_deleted`),
    db.execute<Record<string, unknown>>(sql`
      SELECT c.id AS creator_id, c.name, sum(s.total_watch_seconds) AS watch_seconds,
             sum(s.play_count) AS plays, max(s.last_watch_at) AS last_watch_at
      FROM video_stats s
      JOIN video_creators vc ON vc.video_id = s.video_id
      JOIN creators c ON c.id = vc.creator_id
      WHERE s.user_id = ${userId}
      GROUP BY c.id`),
  ]);
  return { videos: videos.map(toVideoFact), tastes: tastes.map(toTaste) };
}

function toVideoFact(row: Record<string, unknown>): VideoFact {
  return {
    id: Number(row.id),
    durationSeconds: Number(row.duration_seconds ?? 0),
    createdAt: date(row.created_at) ?? new Date(0),
    creatorIds: ids(row.creator_ids),
    playCount: Number(row.play_count ?? 0),
    watchSeconds: Number(row.watch_seconds ?? 0),
    lastWatchedAt: date(row.last_watch_at),
  };
}

function toTaste(row: Record<string, unknown>): CreatorTaste {
  return {
    creatorId: Number(row.creator_id),
    name: String(row.name ?? ""),
    watchSeconds: Number(row.watch_seconds ?? 0),
    plays: Number(row.plays ?? 0),
    lastWatchedAt: date(row.last_watch_at),
  };
}

/** Manual bookmarks and finished automatic ones (those with an interval) of available videos. */
export async function loadBookmarks(userId: number): Promise<BookmarkFact[]> {
  const rows = env.DEMO_MODE
    ? ((await demoSqlite())
        .query(
          `SELECT b.id, b.video_id, b.timestamp_seconds, b.end_timestamp_seconds, b.peak_timestamp_seconds, b.origin, b.name
           FROM demo_bookmarks b JOIN demo_videos v ON v.id = b.video_id
           WHERE v.is_available = 1`
        )
        .all() as Record<string, unknown>[])
    : await db.execute<Record<string, unknown>>(sql`
        SELECT b.id, b.video_id, b.timestamp_seconds, b.end_timestamp_seconds, b.peak_timestamp_seconds, b.origin, b.name
        FROM bookmarks b JOIN videos v ON v.id = b.video_id
        WHERE b.user_id = ${userId} AND v.is_available AND NOT v.is_deleted`);
  return rows.map((row) => ({
    id: Number(row.id),
    videoId: Number(row.video_id),
    start: Number(row.timestamp_seconds),
    end: row.end_timestamp_seconds === null ? null : Number(row.end_timestamp_seconds),
    peak: row.peak_timestamp_seconds === null ? null : Number(row.peak_timestamp_seconds),
    origin: row.origin === "automatic" ? "automatic" : "manual",
    name: String(row.name ?? ""),
  }));
}

/** Highest-scored related videos for a source video (the related service caches these). */
export async function loadRelated(userId: number, videoId: number, limit: number): Promise<number[]> {
  const { videosRelatedService } = await import("@/modules/videos/videos.related.service");
  try {
    const result = await videosRelatedService.getRelated(userId, videoId, { limit });
    return result.data.map((item) => item.video.id);
  } catch {
    return [];
  }
}
