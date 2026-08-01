import { demoRepository, getDemoSqlite } from "@/database/demo";
import type {
  ActivityByHour,
  CodecBreakdown,
  ContentSnapshot,
  CurrentContentStats,
  CurrentLibraryStats,
  CurrentStorageStats,
  CurrentUsageStats,
  LibrarySnapshot,
  ResolutionBreakdown,
  StorageSnapshot,
  TopItem,
  TopWatched,
  UsageSnapshot,
} from "./stats.types";

const DEMO_TIMESTAMP = "2026-01-01T12:00:00.000Z";

type SnapshotKind = "storage" | "library" | "content" | "usage";

interface CountRow {
  value: number;
}

/** Aggregate and snapshot statistics computed only from the demo SQLite catalog. */
export class StatsDemoService {
  async getCurrentStorageStats(): Promise<CurrentStorageStats> {
    const sqlite = getDemoSqlite();
    const video = sqlite
      .query<
        { size: number; count: number },
        []
      >("SELECT coalesce(sum(file_size_bytes), 0) size, count(*) count FROM demo_videos")
      .get()!;
    const thumbnailsSize = this.sum("demo_thumbnails", "file_size_bytes");
    const storyboardsSize = this.sum("demo_storyboards", "sprite_size_bytes");
    const databaseSize =
      Number(
        sqlite.query<{ page_count: number }, []>("PRAGMA page_count").get()
          ?.page_count ?? 0
      ) *
      Number(
        sqlite.query<{ page_size: number }, []>("PRAGMA page_size").get()
          ?.page_size ?? 0
      );
    const convertedSize = (
      demoRepository.listResources("conversion-job") as Array<{
        status: string;
        output_size_bytes: number | null;
      }>
    )
      .filter((job) => job.status === "completed")
      .reduce((total, job) => total + (job.output_size_bytes ?? 0), 0);

    const directoryBreakdown = sqlite
      .query<
        { directory_id: number; size_bytes: number; video_count: number },
        []
      >(
        `SELECT directory_id,
                coalesce(sum(file_size_bytes), 0) size_bytes,
                count(*) video_count
         FROM demo_videos
         GROUP BY directory_id
         ORDER BY directory_id`
      )
      .all()
      .map((row) => ({
        ...row,
        path: `demo://library/${row.directory_id}`,
      }));

    return {
      total_video_size_bytes: Number(video.size),
      total_video_count: Number(video.count),
      thumbnails_size_bytes: thumbnailsSize,
      storyboards_size_bytes: storyboardsSize,
      profile_pictures_size_bytes: 0,
      converted_size_bytes: convertedSize,
      faces_size_bytes: 0,
      database_size_bytes: databaseSize,
      directory_breakdown: directoryBreakdown,
      total_managed_size_bytes:
        Number(video.size) +
        thumbnailsSize +
        storyboardsSize +
        convertedSize +
        databaseSize,
    };
  }

  async getCurrentLibraryStats(): Promise<CurrentLibraryStats> {
    const sqlite = getDemoSqlite();
    const aggregate = sqlite
      .query<
        {
          total: number;
          available: number;
          size: number;
          duration: number;
        },
        []
      >(
        `SELECT count(*) total,
                coalesce(sum(CASE WHEN is_available = 1 THEN 1 ELSE 0 END), 0) available,
                coalesce(sum(file_size_bytes), 0) size,
                coalesce(sum(duration_seconds), 0) duration
         FROM demo_videos`
      )
      .get()!;
    const total = Number(aggregate.total);

    return {
      total_video_count: total,
      available_video_count: Number(aggregate.available),
      unavailable_video_count: total - Number(aggregate.available),
      total_size_bytes: Number(aggregate.size),
      average_size_bytes: total ? Number(aggregate.size) / total : 0,
      total_duration_seconds: Number(aggregate.duration),
      average_duration_seconds: total ? Number(aggregate.duration) / total : 0,
      resolution_breakdown: this.breakdown<ResolutionBreakdown>(
        `CASE
           WHEN height >= 2160 THEN '4K'
           WHEN height >= 1440 THEN '1440p'
           WHEN height >= 1080 THEN '1080p'
           WHEN height >= 720 THEN '720p'
           ELSE 'SD'
         END`,
        "resolution",
        total
      ),
      codec_breakdown: this.breakdown<CodecBreakdown>(
        "coalesce(codec, 'unknown')",
        "codec",
        total
      ),
    };
  }

  async getCurrentContentStats(): Promise<CurrentContentStats> {
    const totalVideos = this.count("demo_videos");
    return {
      total_video_count: totalVideos,
      videos_without_tags: this.withoutRelation("demo_video_tags", "tag_id"),
      videos_without_creators: this.withoutRelation(
        "demo_video_creators",
        "creator_id"
      ),
      videos_without_studios: this.withoutRelation(
        "demo_video_studios",
        "studio_id"
      ),
      videos_without_ratings: this.withoutRelation("demo_ratings", "rating"),
      videos_without_thumbnails: this.withoutRelation(
        "demo_thumbnails",
        "file_path"
      ),
      videos_without_storyboards: this.withoutRelation(
        "demo_storyboards",
        "sprite_path"
      ),
      total_tags: this.count("demo_tags"),
      total_creators: this.count("demo_creators"),
      total_studios: this.count("demo_studios"),
      total_playlists: this.count("demo_playlists"),
      top_tags: this.topItems("demo_tags", "demo_video_tags", "tag_id"),
      top_creators: this.topItems(
        "demo_creators",
        "demo_video_creators",
        "creator_id"
      ),
    };
  }

  async getCurrentUsageStats(): Promise<CurrentUsageStats> {
    const sqlite = getDemoSqlite();
    const aggregate = sqlite
      .query<
        {
          watch: number;
          plays: number;
          watched: number;
          completion: number | null;
        },
        []
      >(
        `SELECT coalesce(sum(total_watch_seconds), 0) watch,
                coalesce(sum(play_count), 0) plays,
                count(CASE WHEN play_count > 0 THEN 1 END) watched,
                avg(CASE
                  WHEN v.duration_seconds > 0
                  THEN min(s.total_watch_seconds / v.duration_seconds, 1.0) * 100
                END) completion
         FROM demo_video_stats s
         JOIN demo_videos v ON v.id = s.video_id`
      )
      .get() ?? { watch: 0, plays: 0, watched: 0, completion: null };
    const topWatched = sqlite
      .query<TopWatched, []>(
        `SELECT s.video_id,
                coalesce(v.title, v.file_name) title,
                s.play_count,
                s.total_watch_seconds
         FROM demo_video_stats s
         JOIN demo_videos v ON v.id = s.video_id
         ORDER BY s.play_count DESC, s.video_id
         LIMIT 10`
      )
      .all();
    const activityByHour: ActivityByHour = {};
    for (const row of sqlite
      .query<{ hour: string; count: number }, []>(
        `SELECT strftime('%H', last_watch_at) hour, count(*) count
         FROM demo_video_stats
         WHERE last_watch_at IS NOT NULL
         GROUP BY hour`
      )
      .all()) {
      activityByHour[row.hour] = Number(row.count);
    }

    return {
      total_watch_time_seconds: Number(aggregate.watch),
      total_play_count: Number(aggregate.plays),
      unique_videos_watched: Number(aggregate.watched),
      videos_never_watched:
        this.count("demo_videos") - Number(aggregate.watched),
      average_completion_rate:
        aggregate.completion === null ? null : Number(aggregate.completion),
      top_watched: topWatched,
      activity_by_hour: activityByHour,
    };
  }

  async createStorageSnapshot(): Promise<StorageSnapshot> {
    return this.createSnapshot("storage", await this.getCurrentStorageStats());
  }

  async createLibrarySnapshot(): Promise<LibrarySnapshot> {
    return this.createSnapshot("library", await this.getCurrentLibraryStats());
  }

  async createContentSnapshot(): Promise<ContentSnapshot> {
    return this.createSnapshot("content", await this.getCurrentContentStats());
  }

  async createUsageSnapshot(): Promise<UsageSnapshot> {
    return this.createSnapshot("usage", await this.getCurrentUsageStats());
  }

  async createAllSnapshots() {
    return {
      storage: await this.createStorageSnapshot(),
      library: await this.createLibrarySnapshot(),
      content: await this.createContentSnapshot(),
      usage: await this.createUsageSnapshot(),
    };
  }

  async getStorageHistory(days = 30, limit = 100): Promise<StorageSnapshot[]> {
    return this.history("storage", days, limit);
  }

  async getLibraryHistory(days = 30, limit = 100): Promise<LibrarySnapshot[]> {
    return this.history("library", days, limit);
  }

  async getContentHistory(days = 30, limit = 100): Promise<ContentSnapshot[]> {
    return this.history("content", days, limit);
  }

  async getUsageHistory(days = 30, limit = 100): Promise<UsageSnapshot[]> {
    return this.history("usage", days, limit);
  }

  private createSnapshot<T extends object>(
    kind: SnapshotKind,
    data: T
  ): T & {
    id: number;
    created_at: string;
  } {
    const resourceKind = this.snapshotResourceKind(kind);
    const existing = demoRepository.listResources(resourceKind) as Array<{
      id: number;
    }>;
    const id = existing.length
      ? Math.max(...existing.map((snapshot) => snapshot.id)) + 1
      : 1;
    const snapshot = { ...data, id, created_at: DEMO_TIMESTAMP };
    demoRepository.putResource(resourceKind, id, snapshot);
    return snapshot;
  }

  private history<T>(kind: SnapshotKind, days: number, limit: number): T[] {
    const threshold = Date.parse(DEMO_TIMESTAMP) - days * 86_400_000;
    return (
      demoRepository.listResources(this.snapshotResourceKind(kind)) as Array<
        T & { created_at: string }
      >
    )
      .filter((snapshot) => Date.parse(snapshot.created_at) >= threshold)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit);
  }

  private snapshotResourceKind(kind: SnapshotKind): string {
    return `stats-${kind}-snapshot`;
  }

  private count(table: string): number {
    this.assertIdentifier(table);
    return Number(
      getDemoSqlite()
        .query<CountRow, []>(`SELECT count(*) value FROM ${table}`)
        .get()?.value ?? 0
    );
  }

  private sum(table: string, column: string): number {
    this.assertIdentifier(table);
    this.assertIdentifier(column);
    return Number(
      getDemoSqlite()
        .query<
          CountRow,
          []
        >(`SELECT coalesce(sum(${column}), 0) value FROM ${table}`)
        .get()?.value ?? 0
    );
  }

  private withoutRelation(table: string, markerColumn: string): number {
    this.assertIdentifier(table);
    this.assertIdentifier(markerColumn);
    return Number(
      getDemoSqlite()
        .query<CountRow, []>(
          `SELECT count(*) value
           FROM demo_videos v
           LEFT JOIN ${table} relation ON relation.video_id = v.id
           WHERE relation.${markerColumn} IS NULL`
        )
        .get()?.value ?? 0
    );
  }

  private topItems(
    entityTable: string,
    relationTable: string,
    entityIdColumn: string
  ): TopItem[] {
    for (const identifier of [entityTable, relationTable, entityIdColumn]) {
      this.assertIdentifier(identifier);
    }
    return getDemoSqlite()
      .query<TopItem, []>(
        `SELECT entity.id, entity.name, count(relation.video_id) video_count
         FROM ${entityTable} entity
         LEFT JOIN ${relationTable} relation
           ON relation.${entityIdColumn} = entity.id
         GROUP BY entity.id, entity.name
         ORDER BY video_count DESC, entity.id
         LIMIT 10`
      )
      .all();
  }

  private breakdown<T>(
    expression: string,
    label: "resolution" | "codec",
    total: number
  ): T[] {
    this.assertIdentifier(label);
    return getDemoSqlite()
      .query<Record<string, unknown>, []>(
        `SELECT ${expression} ${label}, count(*) count
         FROM demo_videos
         GROUP BY ${label}
         ORDER BY count DESC, ${label}`
      )
      .all()
      .map((row) => ({
        [label]: String(row[label]),
        count: Number(row.count),
        percentage: total ? (Number(row.count) / total) * 100 : 0,
      })) as T[];
  }

  private assertIdentifier(value: string): void {
    if (!/^[a-z_]+$/.test(value)) {
      throw new Error(`Unsafe SQLite identifier: ${value}`);
    }
  }
}

export const statsDemoService = new StatsDemoService();
