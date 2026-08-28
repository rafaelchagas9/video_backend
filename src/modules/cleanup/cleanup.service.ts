import { and, eq, sql } from "drizzle-orm";
import { db } from "@/config/drizzle";
import { env } from "@/config/env";
import { cleanupReviewsTable, videosTable } from "@/database/schema";
import { ConflictError, NotFoundError } from "@/utils/errors";
import { API_PREFIX } from "@/config/constants";
import { cleanupDemoService } from "./cleanup.demo.service";
import type {
  CleanupCandidate,
  CleanupDisposition,
  CleanupOverview,
} from "./cleanup.types";

const MIN_AGE_DAYS = 30;
const MAX_WATCH_SECONDS = 300;
const MAX_WATCH_FRACTION = 0.1;
const DAILY_GOAL = 10;

type RawCandidate = {
  id: number | string;
  title: string | null;
  file_name: string;
  file_size_bytes: number | string;
  duration_seconds: number | string | null;
  indexed_at: Date | string;
  codec: string | null;
  bitrate: number | string | null;
  thumbnail_id: number | string | null;
  creators: Array<{ id: number; name: string }> | string | null;
  play_count: number | string;
  total_watch_seconds: number | string;
  last_watched_at: Date | string | null;
  favorite: boolean;
  favorited_creator: boolean;
  high_rating: boolean;
  bookmark: boolean;
  playlist: boolean;
  collection: boolean;
  active_job: boolean;
  eligible: boolean;
  disposition: CleanupDisposition | null;
  revision: number | string | null;
  reviewed_at: Date | string | null;
  total_rows: number | string;
};

function iso(value: Date | string | null): string | null {
  if (!value) return null;
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function parseCreators(
  value: RawCandidate["creators"]
): Array<{ id: number; name: string }> {
  if (!value) return [];
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  return Array.isArray(parsed)
    ? parsed.map((creator) => ({
        id: Number(creator.id),
        name: String(creator.name),
      }))
    : [];
}

function streakDays(activity: Array<{ date: string; count: number }>): number {
  const days = new Set(
    activity.filter((item) => item.count > 0).map((item) => item.date)
  );
  const cursor = new Date();
  let streak = 0;
  for (;;) {
    const key = cursor.toISOString().slice(0, 10);
    if (!days.has(key)) break;
    streak += 1;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return streak;
}

function mapCandidate(row: RawCandidate): CleanupCandidate {
  const duration =
    row.duration_seconds === null ? null : Number(row.duration_seconds);
  const watched = Number(row.total_watch_seconds);
  const watchedFraction =
    duration && duration > 0 ? Math.min(1, watched / duration) : 0;
  const reasons = ["large file", "older than 30 days"];
  if (watched === 0) reasons.push("not watched");
  else reasons.push("lightly watched");
  if (row.collection) reasons.push("part of a collection");

  return {
    id: Number(row.id),
    title: row.title,
    file_name: row.file_name,
    file_size_bytes: Number(row.file_size_bytes),
    duration_seconds: duration,
    indexed_at: iso(row.indexed_at)!,
    codec: row.codec,
    bitrate: row.bitrate === null ? null : Number(row.bitrate),
    thumbnail_url: row.thumbnail_id
      ? `${API_PREFIX}/thumbnails/${Number(row.thumbnail_id)}/image`
      : null,
    creators: parseCreators(row.creators),
    engagement: {
      play_count: Number(row.play_count),
      total_watch_seconds: watched,
      watched_fraction: watchedFraction,
      last_watched_at: iso(row.last_watched_at),
    },
    protections: {
      favorite: Boolean(row.favorite),
      favorited_creator: Boolean(row.favorited_creator),
      high_rating: Boolean(row.high_rating),
      bookmark: Boolean(row.bookmark),
      playlist: Boolean(row.playlist),
      collection: Boolean(row.collection),
      active_job: Boolean(row.active_job),
    },
    reasons,
    eligible: Boolean(row.eligible),
    disposition: row.disposition ?? "unreviewed",
    revision: Number(row.revision ?? 0),
    reviewed_at: iso(row.reviewed_at),
  };
}

export class CleanupService {
  async listCandidates(
    userId: number,
    options: { disposition: CleanupDisposition; limit: number; offset: number }
  ): Promise<{ data: CleanupCandidate[]; total: number }> {
    if (env.DEMO_MODE)
      return cleanupDemoService.listCandidates(userId, options);
    const rows = (await db.execute(sql`
      WITH engagement AS (
        SELECT v.id,
          COALESCE(SUM(vs.play_count), 0)::int AS play_count,
          COALESCE(SUM(vs.total_watch_seconds), 0)::real AS total_watch_seconds,
          MAX(COALESCE(vs.last_watch_at, vs.last_played_at)) AS last_watched_at
        FROM videos v
        LEFT JOIN video_stats vs ON vs.video_id = v.id AND vs.user_id = ${userId}
        GROUP BY v.id
      ), signals AS (
        SELECT v.id, v.title, v.file_name, v.file_size_bytes, v.duration_seconds,
          v.indexed_at, v.codec, v.bitrate, t.id AS thumbnail_id,
          COALESCE((SELECT jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name) ORDER BY c.name)
            FROM video_creators vc JOIN creators c ON c.id = vc.creator_id WHERE vc.video_id = v.id), '[]'::jsonb) creators,
          e.play_count, e.total_watch_seconds, e.last_watched_at,
          EXISTS(SELECT 1 FROM favorites f WHERE f.video_id=v.id AND f.user_id=${userId}) favorite,
          EXISTS(SELECT 1 FROM video_creators vc JOIN creator_favorites cf ON cf.creator_id=vc.creator_id AND cf.user_id=${userId} WHERE vc.video_id=v.id) favorited_creator,
          EXISTS(SELECT 1 FROM ratings r WHERE r.video_id=v.id AND r.rating>=4) high_rating,
          EXISTS(SELECT 1 FROM bookmarks b WHERE b.video_id=v.id AND b.user_id=${userId}) bookmark,
          EXISTS(SELECT 1 FROM playlist_videos pv JOIN playlists p ON p.id=pv.playlist_id AND p.user_id=${userId} WHERE pv.video_id=v.id) playlist,
          EXISTS(SELECT 1 FROM video_collection_entries vce WHERE vce.video_id=v.id) collection,
          (EXISTS(SELECT 1 FROM conversion_jobs cj WHERE cj.video_id=v.id AND cj.status IN ('pending','processing'))
            OR EXISTS(SELECT 1 FROM edit_jobs ej WHERE ej.active_video_id=v.id)) active_job,
          cr.disposition, cr.revision, cr.updated_at reviewed_at
        FROM videos v
        JOIN engagement e ON e.id=v.id
        LEFT JOIN thumbnails t ON t.video_id=v.id
        LEFT JOIN cleanup_reviews cr ON cr.video_id=v.id AND cr.user_id=${userId}
        WHERE v.is_available=true
      ), ranked AS (
        SELECT *,
          (indexed_at <= NOW() - INTERVAL '30 days'
            AND total_watch_seconds < GREATEST(${MAX_WATCH_SECONDS}::real, COALESCE(duration_seconds,0)*${MAX_WATCH_FRACTION}::real)
            AND NOT favorite AND NOT favorited_creator AND NOT high_rating
            AND NOT bookmark AND NOT playlist AND NOT active_job) AS eligible
        FROM signals
      )
      SELECT *, COUNT(*) OVER() AS total_rows
      FROM ranked
      WHERE CASE
        WHEN ${options.disposition} = 'unreviewed' THEN disposition IS NULL AND eligible
        ELSE disposition = ${options.disposition}
      END
      ORDER BY file_size_bytes DESC, id DESC
      LIMIT ${options.limit} OFFSET ${options.offset}
    `)) as unknown as RawCandidate[];
    return {
      data: rows.map(mapCandidate),
      total: Number(rows[0]?.total_rows ?? 0),
    };
  }

  async overview(userId: number): Promise<CleanupOverview> {
    if (env.DEMO_MODE) return cleanupDemoService.overview(userId);
    const [aggregate] = (await db.execute(sql`
      WITH engagement AS (
        SELECT v.id, COALESCE(SUM(vs.total_watch_seconds),0)::real total_watch_seconds
        FROM videos v LEFT JOIN video_stats vs ON vs.video_id=v.id AND vs.user_id=${userId}
        GROUP BY v.id
      ), eligible AS (
        SELECT v.id, v.file_size_bytes, cr.disposition,
          (v.indexed_at <= NOW() - INTERVAL '30 days'
           AND e.total_watch_seconds < GREATEST(${MAX_WATCH_SECONDS}::real,COALESCE(v.duration_seconds,0)*${MAX_WATCH_FRACTION}::real)
           AND NOT EXISTS(SELECT 1 FROM favorites f WHERE f.video_id=v.id AND f.user_id=${userId})
           AND NOT EXISTS(SELECT 1 FROM video_creators vc JOIN creator_favorites cf ON cf.creator_id=vc.creator_id AND cf.user_id=${userId} WHERE vc.video_id=v.id)
           AND NOT EXISTS(SELECT 1 FROM ratings r WHERE r.video_id=v.id AND r.rating>=4)
           AND NOT EXISTS(SELECT 1 FROM bookmarks b WHERE b.video_id=v.id AND b.user_id=${userId})
           AND NOT EXISTS(SELECT 1 FROM playlist_videos pv JOIN playlists p ON p.id=pv.playlist_id AND p.user_id=${userId} WHERE pv.video_id=v.id)
           AND NOT EXISTS(SELECT 1 FROM conversion_jobs cj WHERE cj.video_id=v.id AND cj.status IN ('pending','processing'))
           AND NOT EXISTS(SELECT 1 FROM edit_jobs ej WHERE ej.active_video_id=v.id)) eligible
        FROM videos v JOIN engagement e ON e.id=v.id
        LEFT JOIN cleanup_reviews cr ON cr.video_id=v.id AND cr.user_id=${userId}
        WHERE v.is_available=true
      )
      SELECT COUNT(*)::int library_count, COALESCE(SUM(file_size_bytes),0)::bigint library_bytes,
        COUNT(*) FILTER(WHERE eligible)::int quick_count,
        COALESCE(SUM(file_size_bytes) FILTER(WHERE eligible),0)::bigint quick_bytes,
        COUNT(*) FILTER(WHERE eligible AND disposition IS NULL)::int unreviewed_count,
        COALESCE(SUM(file_size_bytes) FILTER(WHERE eligible AND disposition IS NULL),0)::bigint unreviewed_bytes,
        COUNT(*) FILTER(WHERE disposition='keep')::int keep_count,
        COALESCE(SUM(file_size_bytes) FILTER(WHERE disposition='keep'),0)::bigint keep_bytes,
        COUNT(*) FILTER(WHERE disposition='delete')::int delete_count,
        COALESCE(SUM(file_size_bytes) FILTER(WHERE disposition='delete'),0)::bigint delete_bytes,
        COUNT(*) FILTER(WHERE disposition='later')::int later_count,
        COALESCE(SUM(file_size_bytes) FILTER(WHERE disposition='later'),0)::bigint later_bytes
      FROM eligible
    `)) as unknown as Array<Record<string, number | string>>;

    const activityRows = (await db.execute(sql`
      SELECT TO_CHAR(DATE(first_reviewed_at), 'YYYY-MM-DD') date,
        COUNT(*)::int count, COALESCE(SUM(v.file_size_bytes),0)::bigint bytes
      FROM cleanup_reviews cr JOIN videos v ON v.id=cr.video_id
      WHERE cr.user_id=${userId} AND first_reviewed_at >= CURRENT_DATE - INTERVAL '13 days'
      GROUP BY DATE(first_reviewed_at) ORDER BY DATE(first_reviewed_at)
    `)) as unknown as Array<{
      date: string;
      count: number | string;
      bytes: number | string;
    }>;
    const activity = activityRows.map((row) => ({
      date: row.date,
      count: Number(row.count),
      bytes: Number(row.bytes),
    }));
    const reviewedCount =
      Number(aggregate.keep_count) +
      Number(aggregate.delete_count) +
      Number(aggregate.later_count);
    const reviewedBytes =
      Number(aggregate.keep_bytes) +
      Number(aggregate.delete_bytes) +
      Number(aggregate.later_bytes);
    const today = new Date().toISOString().slice(0, 10);
    return {
      policy: {
        min_age_days: MIN_AGE_DAYS,
        max_watch_seconds: MAX_WATCH_SECONDS,
        max_watch_fraction: MAX_WATCH_FRACTION,
      },
      library: {
        count: Number(aggregate.library_count),
        bytes: Number(aggregate.library_bytes),
      },
      quick_wins: {
        count: Number(aggregate.quick_count),
        bytes: Number(aggregate.quick_bytes),
        unreviewed_count: Number(aggregate.unreviewed_count),
        unreviewed_bytes: Number(aggregate.unreviewed_bytes),
      },
      decisions: {
        keep: {
          count: Number(aggregate.keep_count),
          bytes: Number(aggregate.keep_bytes),
        },
        delete: {
          count: Number(aggregate.delete_count),
          bytes: Number(aggregate.delete_bytes),
        },
        later: {
          count: Number(aggregate.later_count),
          bytes: Number(aggregate.later_bytes),
        },
      },
      rewards: {
        reviewed_count: reviewedCount,
        reviewed_bytes: reviewedBytes,
        today_count: activity.find((item) => item.date === today)?.count ?? 0,
        daily_goal: DAILY_GOAL,
        streak_days: streakDays(activity),
        activity,
      },
    };
  }

  async saveReview(
    userId: number,
    videoId: number,
    disposition: CleanupDisposition,
    expectedRevision: number
  ) {
    if (env.DEMO_MODE)
      return cleanupDemoService.saveReview(
        userId,
        videoId,
        disposition,
        expectedRevision
      );
    const [video] = await db
      .select({ id: videosTable.id })
      .from(videosTable)
      .where(eq(videosTable.id, videoId))
      .limit(1);
    if (!video) throw new NotFoundError("Video not found");
    const [current] = await db
      .select()
      .from(cleanupReviewsTable)
      .where(
        and(
          eq(cleanupReviewsTable.userId, userId),
          eq(cleanupReviewsTable.videoId, videoId)
        )
      )
      .limit(1);
    const revision = current?.revision ?? 0;
    if (revision !== expectedRevision)
      throw new ConflictError("Cleanup decision changed on another device");
    if (disposition === "unreviewed") {
      if (current) {
        await db
          .delete(cleanupReviewsTable)
          .where(
            and(
              eq(cleanupReviewsTable.userId, userId),
              eq(cleanupReviewsTable.videoId, videoId)
            )
          );
      }
      return {
        video_id: videoId,
        disposition,
        revision: 0,
        reviewed_at: null,
      };
    }
    const [saved] = await db
      .insert(cleanupReviewsTable)
      .values({
        userId,
        videoId,
        disposition,
        revision: revision + 1,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [cleanupReviewsTable.userId, cleanupReviewsTable.videoId],
        set: { disposition, revision: revision + 1, updatedAt: new Date() },
      })
      .returning();
    if (!saved) throw new Error("Failed to save cleanup decision");
    return {
      video_id: videoId,
      disposition,
      revision: saved.revision,
      reviewed_at: saved.updatedAt.toISOString(),
    };
  }
}

export const cleanupService = new CleanupService();
