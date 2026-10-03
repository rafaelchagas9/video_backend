import { eq, inArray, sql } from "drizzle-orm";
import { db } from "@/config/drizzle";
import { env } from "@/config/env";
import { videoWatchHeatTable } from "@/database/schema";
import { logger } from "@/utils/logger";
import {
  addPass,
  curve,
  HEAT_BUCKET_SECONDS,
  HEAT_MIN_WATCHED_SECONDS,
  peaks,
  type HeatPeak,
} from "./watch-heat.model";

export interface Heatmap {
  video_id: number;
  /** Seconds each curve point spans; the curve covers the whole duration. */
  point_seconds: number;
  curve: number[];
  peaks: HeatPeak[];
  watched_seconds: number;
  /** False until enough has been watched for the shape to mean something. */
  meaningful: boolean;
}

interface HeatRow {
  buckets: number[];
  watchedSeconds: number;
}

/** Deterministic replay patterns for demo videos, so the curve is reviewable there. */
function demoHeat(videoId: number, durationSeconds: number): HeatRow {
  let seed = videoId * 2654435761;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  let buckets = addPass([], 0, durationSeconds * (0.35 + random() * 0.65));
  const hotspots = 1 + Math.floor(random() * 3);
  for (let spot = 0; spot < hotspots; spot++) {
    const at = durationSeconds * (0.15 + random() * 0.7);
    const length = Math.min(durationSeconds * 0.12, 15 + random() * 40);
    const replays = 2 + Math.floor(random() * 5);
    for (let replay = 0; replay < replays; replay++)
      buckets = addPass(buckets, Math.max(0, at - length / 2), Math.min(durationSeconds, at + length / 2));
  }
  return { buckets, watchedSeconds: durationSeconds * 2 };
}

const demoRecorded = new Map<number, HeatRow>();

export class WatchHeatService {
  /** One reported stretch of contiguous watching. Never throws: heat is best-effort. */
  async record(videoId: number, fromSeconds: number, toSeconds: number): Promise<void> {
    if (!(toSeconds > fromSeconds)) return;
    if (env.DEMO_MODE) {
      const current = demoRecorded.get(videoId) ?? { buckets: [], watchedSeconds: 0 };
      demoRecorded.set(videoId, {
        buckets: addPass(current.buckets, fromSeconds, toSeconds),
        watchedSeconds: current.watchedSeconds + (toSeconds - fromSeconds),
      });
      return;
    }
    try {
      await db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(videoWatchHeatTable)
          .where(eq(videoWatchHeatTable.videoId, videoId))
          .for("update");
        const buckets = addPass(row?.buckets ?? [], fromSeconds, toSeconds, row?.bucketSeconds ?? HEAT_BUCKET_SECONDS);
        const watchedSeconds = (row?.watchedSeconds ?? 0) + (toSeconds - fromSeconds);
        await tx
          .insert(videoWatchHeatTable)
          .values({ videoId, buckets, watchedSeconds, updatedAt: new Date() })
          .onConflictDoUpdate({
            target: videoWatchHeatTable.videoId,
            set: { buckets, watchedSeconds, updatedAt: new Date() },
          });
      });
    } catch (error) {
      logger.warn({ error, videoId }, "Could not record watch heat");
    }
  }

  private async rows(videoIds: number[], durations: Map<number, number>): Promise<Map<number, HeatRow>> {
    const out = new Map<number, HeatRow>();
    if (!videoIds.length) return out;
    if (env.DEMO_MODE) {
      for (const id of videoIds) {
        const duration = durations.get(id);
        if (!duration) continue;
        const synthetic = demoHeat(id, duration);
        const recorded = demoRecorded.get(id);
        out.set(
          id,
          recorded
            ? {
                buckets: synthetic.buckets.map((value, index) => value + (recorded.buckets[index] ?? 0)),
                watchedSeconds: synthetic.watchedSeconds + recorded.watchedSeconds,
              }
            : synthetic
        );
      }
      return out;
    }
    const rows = await db
      .select({
        videoId: videoWatchHeatTable.videoId,
        buckets: videoWatchHeatTable.buckets,
        watchedSeconds: videoWatchHeatTable.watchedSeconds,
      })
      .from(videoWatchHeatTable)
      .where(inArray(videoWatchHeatTable.videoId, videoIds));
    for (const row of rows) out.set(row.videoId, row);
    return out;
  }

  async heatmap(videoId: number, durationSeconds: number): Promise<Heatmap> {
    const row = (await this.rows([videoId], new Map([[videoId, durationSeconds]]))).get(videoId);
    const buckets = row?.buckets ?? [];
    const points = curve(buckets, durationSeconds);
    return {
      video_id: videoId,
      point_seconds: points.length ? durationSeconds / points.length : HEAT_BUCKET_SECONDS,
      curve: points,
      peaks: peaks(buckets, durationSeconds),
      watched_seconds: Math.round(row?.watchedSeconds ?? 0),
      meaningful: (row?.watchedSeconds ?? 0) >= HEAT_MIN_WATCHED_SECONDS,
    };
  }

  /** The replay peaks of many videos at once, for feeds and home rails. */
  async peaksFor(durations: Map<number, number>): Promise<Map<number, HeatPeak[]>> {
    const rows = await this.rows([...durations.keys()], durations);
    const out = new Map<number, HeatPeak[]>();
    for (const [videoId, row] of rows) {
      const duration = durations.get(videoId);
      if (!duration || row.watchedSeconds < HEAT_MIN_WATCHED_SECONDS) continue;
      const found = peaks(row.buckets, duration);
      if (found.length) out.set(videoId, found);
    }
    return out;
  }

  /** Videos with any recorded heat, hottest-watched first (real library only). */
  async heatedVideoIds(limit: number): Promise<number[]> {
    if (env.DEMO_MODE) return [];
    const rows = await db.execute<{ video_id: number }>(sql`
      SELECT video_id FROM video_watch_heat
      WHERE watched_seconds >= ${HEAT_MIN_WATCHED_SECONDS}
      ORDER BY updated_at DESC LIMIT ${limit}`);
    return rows.map((row) => Number(row.video_id));
  }
}

export const watchHeatService = new WatchHeatService();
