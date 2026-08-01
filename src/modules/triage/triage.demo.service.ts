import {
  getDemoSqlite,
  initializeDemoDatabase,
  withDemoTransaction,
} from "@/database/demo";
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

  async getStatistics(): Promise<TriageStatistics> {
    initializeDemoDatabase();
    const sqlite = getDemoSqlite();
    const totalVideos = Number(
      sqlite
        .query<
          { count: number },
          []
        >("SELECT COUNT(*) AS count FROM demo_videos WHERE is_available = 1")
        .get()?.count ?? 0
    );
    const videosWithCreators = Number(
      sqlite
        .query<{ count: number }, []>(
          `SELECT COUNT(DISTINCT vc.video_id) AS count
           FROM demo_video_creators vc
           JOIN demo_videos v ON v.id = vc.video_id
           WHERE v.is_available = 1`
        )
        .get()?.count ?? 0
    );
    const tagged24h = Number(
      sqlite
        .query<{ count: number }, []>(
          `SELECT COUNT(*) AS count FROM demo_videos v
           WHERE v.is_available = 1
             AND EXISTS (
               SELECT 1 FROM demo_video_creators vc WHERE vc.video_id = v.id
             )
             AND datetime(v.indexed_at) >= datetime('now', '-1 day')`
        )
        .get()?.count ?? 0
    );
    const tagged7d = Number(
      sqlite
        .query<{ count: number }, []>(
          `SELECT COUNT(*) AS count FROM demo_videos v
           WHERE v.is_available = 1
             AND EXISTS (
               SELECT 1 FROM demo_video_creators vc WHERE vc.video_id = v.id
             )
             AND datetime(v.indexed_at) >= datetime('now', '-7 days')`
        )
        .get()?.count ?? 0
    );
    const progress = this.allProgress();
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
        avg_daily_rate: tagged24h,
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
    initializeDemoDatabase();
    const details = {
      creators_added: 0,
      creators_removed: 0,
      tags_added: 0,
      tags_removed: 0,
      studios_added: 0,
      studios_removed: 0,
    };
    if (input.videoIds.length === 0) {
      return { success: true, processed: 0, errors: 0, details };
    }

    try {
      withDemoTransaction(() => {
        details.creators_added = this.addRelationships(
          "demo_video_creators",
          "creator_id",
          input.videoIds,
          input.actions.addCreatorIds
        );
        details.creators_removed = this.removeRelationships(
          "demo_video_creators",
          "creator_id",
          input.videoIds,
          input.actions.removeCreatorIds
        );
        details.tags_added = this.addRelationships(
          "demo_video_tags",
          "tag_id",
          input.videoIds,
          input.actions.addTagIds
        );
        details.tags_removed = this.removeRelationships(
          "demo_video_tags",
          "tag_id",
          input.videoIds,
          input.actions.removeTagIds
        );
        details.studios_added = this.addRelationships(
          "demo_video_studios",
          "studio_id",
          input.videoIds,
          input.actions.addStudioIds
        );
        details.studios_removed = this.removeRelationships(
          "demo_video_studios",
          "studio_id",
          input.videoIds,
          input.actions.removeStudioIds
        );
      });
      return {
        success: true,
        processed: input.videoIds.length,
        errors: 0,
        details,
      };
    } catch {
      return {
        success: false,
        processed: input.videoIds.length,
        errors: 1,
        details: {
          creators_added: 0,
          creators_removed: 0,
          tags_added: 0,
          tags_removed: 0,
          studios_added: 0,
          studios_removed: 0,
        },
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

  private addRelationships(
    table: string,
    targetColumn: string,
    videoIds: number[],
    targetIds: number[] | undefined
  ): number {
    let changes = 0;
    for (const videoId of videoIds) {
      for (const targetId of targetIds ?? []) {
        changes += getDemoSqlite().run(
          `INSERT OR IGNORE INTO ${table} (video_id, ${targetColumn}) VALUES (?, ?)`,
          [videoId, targetId]
        ).changes;
      }
    }
    return changes;
  }

  private removeRelationships(
    table: string,
    targetColumn: string,
    videoIds: number[],
    targetIds: number[] | undefined
  ): number {
    let changes = 0;
    for (const videoId of videoIds) {
      for (const targetId of targetIds ?? []) {
        changes += getDemoSqlite().run(
          `DELETE FROM ${table} WHERE video_id = ? AND ${targetColumn} = ?`,
          [videoId, targetId]
        ).changes;
      }
    }
    return changes;
  }
}

export const triageDemoService = new TriageDemoService();
