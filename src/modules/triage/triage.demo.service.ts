import { getDemoSqlite, initializeDemoDatabase } from "@/database/demo";
import {
  videoRelationshipsService,
  emptyRelationshipCounts,
} from "@/modules/videos/videos.relationships.service";
import { ConflictError } from "@/utils/errors";
import type {
  GetTriageProgressInput,
  SaveTriageProgressInput,
  TriageBulkActionsInput,
  TriageBulkActionsResult,
  TriageProgress,
  TriageStatistics,
} from "./triage.types";

const RESOURCE_KIND = "triage-progress";

interface ResourceRow {
  payload_json: string;
}

interface DirectoryResource {
  id: number;
  path: string;
}

function progressId(userId: number, filterKey: string): string {
  return `${userId}:${filterKey}`;
}

function now(): string {
  return new Date().toISOString();
}

/** Isolated triage progress and relationship operations for demo mode. */
export class TriageDemoService {
  async saveProgress(
    userId: number,
    input: SaveTriageProgressInput
  ): Promise<void> {
    initializeDemoDatabase();
    const existing = await this.getProgress(userId, {
      filterKey: input.filterKey,
    });
    const timestamp = now();
    const progress: TriageProgress = {
      id: existing?.id ?? this.nextProgressId(),
      user_id: userId,
      filter_key: input.filterKey,
      last_video_id: input.lastVideoId ?? null,
      processed_count: input.processedCount,
      total_count: input.totalCount ?? null,
      created_at: existing?.created_at ?? timestamp,
      updated_at: timestamp,
    };
    getDemoSqlite().run(
      `INSERT INTO demo_resources
       (kind, id, payload_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(kind, id) DO UPDATE SET
         payload_json = excluded.payload_json,
         updated_at = excluded.updated_at`,
      [
        RESOURCE_KIND,
        progressId(userId, input.filterKey),
        JSON.stringify(progress),
        progress.created_at,
        progress.updated_at,
      ]
    );
  }

  async getProgress(
    userId: number,
    input: GetTriageProgressInput
  ): Promise<TriageProgress | null> {
    initializeDemoDatabase();
    const row = getDemoSqlite()
      .query<
        ResourceRow,
        [string, string]
      >("SELECT payload_json FROM demo_resources WHERE kind = ? AND id = ?")
      .get(RESOURCE_KIND, progressId(userId, input.filterKey));
    return row ? (JSON.parse(row.payload_json) as TriageProgress) : null;
  }

  async deleteProgress(userId: number, filterKey: string): Promise<void> {
    initializeDemoDatabase();
    getDemoSqlite().run(
      "DELETE FROM demo_resources WHERE kind = ? AND id = ?",
      [RESOURCE_KIND, progressId(userId, filterKey)]
    );
  }

  async listProgress(userId: number): Promise<TriageProgress[]> {
    initializeDemoDatabase();
    return getDemoSqlite()
      .query<ResourceRow, [string, string]>(
        `SELECT payload_json FROM demo_resources
         WHERE kind = ? AND id LIKE ? ORDER BY updated_at DESC`
      )
      .all(RESOURCE_KIND, `${userId}:%`)
      .map((row) => JSON.parse(row.payload_json) as TriageProgress);
  }

  async getStatistics(userId: number): Promise<TriageStatistics> {
    initializeDemoDatabase();
    const sqlite = getDemoSqlite();
    const summary = sqlite
      .query<
        {
          total: number;
          tagged: number;
          indexed_24h: number;
          indexed_7d: number;
        },
        []
      >(
        `
      SELECT COUNT(*) AS total, COUNT(vc.video_id) AS tagged,
        COUNT(CASE WHEN datetime(v.indexed_at) >= datetime('now', '-1 day') THEN vc.video_id END) AS indexed_24h,
        COUNT(CASE WHEN datetime(v.indexed_at) >= datetime('now', '-7 days') THEN vc.video_id END) AS indexed_7d
      FROM demo_videos v
      LEFT JOIN (SELECT DISTINCT video_id FROM demo_video_creators) vc ON vc.video_id = v.id
      WHERE v.is_available = 1
    `
      )
      .get()!;
    const totalVideos = summary.total;
    const videosWithCreators = summary.tagged;
    const tagged24h = summary.indexed_24h;
    const tagged7d = summary.indexed_7d;
    const progress = await this.listProgress(userId);
    const directoryPaths = new Map(
      sqlite
        .query<ResourceRow, [string]>(
          "SELECT payload_json FROM demo_resources WHERE kind = ?"
        )
        .all("directory")
        .map((row) => JSON.parse(row.payload_json) as DirectoryResource)
        .map((directory) => [directory.id, directory.path])
    );
    const topDirectories = sqlite
      .query<{ directory_id: number; untagged_count: number }, []>(
        `SELECT v.directory_id, COUNT(*) AS untagged_count
         FROM demo_videos v
         WHERE v.is_available = 1
           AND NOT EXISTS (
             SELECT 1 FROM demo_video_creators vc WHERE vc.video_id = v.id
           )
         GROUP BY v.directory_id
         ORDER BY untagged_count DESC, v.directory_id ASC
         LIMIT 10`
      )
      .all()
      .map((row) => ({
        directory_id: Number(row.directory_id),
        path:
          directoryPaths.get(Number(row.directory_id)) ??
          `demo_mode/directory-${row.directory_id}`,
        untagged_count: Number(row.untagged_count),
      }));

    return {
      total_untagged_videos: totalVideos - videosWithCreators,
      total_videos: totalVideos,
      tagged_percentage:
        totalVideos > 0
          ? Math.round((videosWithCreators / totalVideos) * 100)
          : 100,
      recent_progress: {
        last_24h_processed: tagged24h,
        last_7d_processed: tagged7d,
        avg_daily_rate: Math.round(tagged7d / 7),
      },
      filter_breakdown: progress.slice(0, 10).map((item) => ({
        filter_key: item.filter_key,
        total: item.total_count ?? 0,
        processed_count: item.processed_count,
        percentage:
          item.total_count && item.total_count > 0
            ? Math.round((item.processed_count / item.total_count) * 100)
            : 0,
      })),
      top_directories: topDirectories,
    };
  }

  async applyBulkActions(
    input: TriageBulkActionsInput
  ): Promise<TriageBulkActionsResult> {
    try {
      const { processed, details } = videoRelationshipsService.applyDemo(
        input.videoIds,
        input.actions
      );
      return { success: true, processed, errors: 0, details };
    } catch (error) {
      if (error instanceof ConflictError) throw error;
      return {
        success: false,
        processed: 0,
        errors: 1,
        details: emptyRelationshipCounts(),
      };
    }
  }

  private allProgress(): TriageProgress[] {
    return getDemoSqlite()
      .query<ResourceRow, [string]>(
        `SELECT payload_json FROM demo_resources
         WHERE kind = ? ORDER BY updated_at DESC`
      )
      .all(RESOURCE_KIND)
      .map((row) => JSON.parse(row.payload_json) as TriageProgress);
  }

  private nextProgressId(): number {
    return (
      this.allProgress().reduce(
        (maximum, item) => Math.max(maximum, item.id),
        0
      ) + 1
    );
  }
}

export const triageDemoService = new TriageDemoService();
