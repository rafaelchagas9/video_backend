import { sql } from "drizzle-orm";
import { db } from "@/config/drizzle";
import { statsContentSnapshotsTable } from "@/database/schema";
import { logger } from "@/utils/logger";
import type {
  CurrentContentStats,
  TopItem,
  ContentSnapshot,
} from "./stats.types";

/**
 * Content organization statistics service
 * Handles stats about tags, creators, studios, and content organization
 */
export class ContentStatsService {
  /**
   * Get current content organization statistics
   */
  async getCurrentContentStats(): Promise<CurrentContentStats> {
    // Videos without organization
    const gapsQuery = sql`
      SELECT
        (SELECT COUNT(*) FROM videos WHERE id NOT IN (SELECT video_id FROM video_tags)) as no_tags,
        (SELECT COUNT(*) FROM videos WHERE id NOT IN (SELECT video_id FROM video_creators)) as no_creators,
        (SELECT COUNT(*) FROM videos WHERE id NOT IN (SELECT video_id FROM ratings)) as no_ratings,
        (SELECT COUNT(*) FROM videos WHERE id NOT IN (SELECT video_id FROM thumbnails)) as no_thumbnails,
        (SELECT COUNT(*) FROM videos WHERE id NOT IN (SELECT video_id FROM storyboards)) as no_storyboards
    `;

    const gapsRows = await db.execute(gapsQuery);
    const gapsRaw = gapsRows[0] as {
      no_tags: string | number;
      no_creators: string | number;
      no_ratings: string | number;
      no_thumbnails: string | number;
      no_storyboards: string | number;
    };

    if (!gapsRaw) {
      throw new Error("Failed to get content gaps");
    }

    const gaps = {
      no_tags: Number(gapsRaw.no_tags),
      no_creators: Number(gapsRaw.no_creators),
      no_ratings: Number(gapsRaw.no_ratings),
      no_thumbnails: Number(gapsRaw.no_thumbnails),
      no_storyboards: Number(gapsRaw.no_storyboards),
    };

    // Entity counts
    const countsQuery = sql`
      SELECT
        (SELECT COUNT(*) FROM tags) as tags,
        (SELECT COUNT(*) FROM creators) as creators,
        (SELECT COUNT(*) FROM studios) as studios,
        (SELECT COUNT(*) FROM playlists) as playlists
    `;

    const countsRows = await db.execute(countsQuery);
    const countsRaw = countsRows[0] as {
      tags: string | number;
      creators: string | number;
      studios: string | number;
      playlists: string | number;
    };

    if (!countsRaw) {
      throw new Error("Failed to get entity counts");
    }

    const counts = {
      tags: Number(countsRaw.tags),
      creators: Number(countsRaw.creators),
      studios: Number(countsRaw.studios),
      playlists: Number(countsRaw.playlists),
    };

    // Top tags
    const topTagsQuery = sql`
      SELECT t.id, t.name, COUNT(vt.video_id) as video_count
      FROM tags t
      LEFT JOIN video_tags vt ON vt.tag_id = t.id
      GROUP BY t.id, t.name
      HAVING COUNT(vt.video_id) > 0
      ORDER BY video_count DESC
      LIMIT 10
    `;

    const topTagsRaw = (await db.execute(topTagsQuery)) as unknown as Array<{
      id: string | number;
      name: string;
      video_count: string | number;
    }>;

    const topTags: TopItem[] = topTagsRaw.map((item) => ({
      id: Number(item.id),
      name: item.name,
      video_count: Number(item.video_count),
    }));

    // Top creators
    const topCreatorsQuery = sql`
      SELECT c.id, c.name, COUNT(vc.video_id) as video_count
      FROM creators c
      LEFT JOIN video_creators vc ON vc.creator_id = c.id
      GROUP BY c.id, c.name
      HAVING COUNT(vc.video_id) > 0
      ORDER BY video_count DESC
      LIMIT 10
    `;

    const topCreatorsRaw = (await db.execute(
      topCreatorsQuery,
    )) as unknown as Array<{
      id: string | number;
      name: string;
      video_count: string | number;
    }>;

    const topCreators: TopItem[] = topCreatorsRaw.map((item) => ({
      id: Number(item.id),
      name: item.name,
      video_count: Number(item.video_count),
    }));

    return {
      videos_without_tags: gaps.no_tags,
      videos_without_creators: gaps.no_creators,
      videos_without_ratings: gaps.no_ratings,
      videos_without_thumbnails: gaps.no_thumbnails,
      videos_without_storyboards: gaps.no_storyboards,
      total_tags: counts.tags,
      total_creators: counts.creators,
      total_studios: counts.studios,
      total_playlists: counts.playlists,
      top_tags: topTags,
      top_creators: topCreators,
    };
  }

  /**
   * Create a content snapshot
   */
  async createContentSnapshot(): Promise<ContentSnapshot> {
    const current = await this.getCurrentContentStats();

    const result = await db
      .insert(statsContentSnapshotsTable)
      .values({
        videosWithoutTags: current.videos_without_tags,
        videosWithoutCreators: current.videos_without_creators,
        videosWithoutRatings: current.videos_without_ratings,
        videosWithoutThumbnails: current.videos_without_thumbnails,
        videosWithoutStoryboards: current.videos_without_storyboards,
        totalTags: current.total_tags,
        totalCreators: current.total_creators,
        totalStudios: current.total_studios,
        totalPlaylists: current.total_playlists,
        topTags: JSON.stringify(current.top_tags),
        topCreators: JSON.stringify(current.top_creators),
      })
      .returning();

    if (!result || result.length === 0) {
      throw new Error("Failed to create content snapshot");
    }

    logger.info({ snapshotId: result[0].id }, "Content snapshot created");

    return this.mapToApiFormat(result[0]);
  }

  /**
   * Get content snapshot history
   */
  async getContentHistory(
    days: number = 30,
    limit: number = 100,
  ): Promise<ContentSnapshot[]> {
    const query = sql`
      SELECT * FROM stats_content_snapshots
      WHERE created_at >= NOW() - INTERVAL '1 day' * ${days}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;

    const rows = await db.execute(query);

    return (rows as any[]).map((row) => this.mapToApiFormat(row));
  }

  /**
   * Get latest content snapshot
   */
  async getLatestContentSnapshot(): Promise<ContentSnapshot | null> {
    const query = sql`
      SELECT * FROM stats_content_snapshots
      ORDER BY created_at DESC
      LIMIT 1
    `;

    const rows = await db.execute(query);

    if (!rows || rows.length === 0) {
      return null;
    }

    return this.mapToApiFormat(rows[0]);
  }

  /**
   * Map Drizzle result to API format
   */
  private mapToApiFormat(row: any): ContentSnapshot {
    // Helper to convert date to ISO string
    const toISOString = (val: unknown): string => {
      if (val instanceof Date) return val.toISOString();
      if (typeof val === "string") return val;
      return new Date().toISOString();
    };

    // Parse top items JSON and ensure numbers
    const parseTopItems = (rawData: unknown): TopItem[] | null => {
      if (!rawData) return null;
      const parsed =
        typeof rawData === "string" ? JSON.parse(rawData) : rawData;
      return Array.isArray(parsed)
        ? parsed.map((item: any) => ({
            id: Number(item.id),
            name: item.name,
            video_count: Number(item.video_count),
          }))
        : null;
    };

    return {
      id: Number(row.id),
      videos_without_tags: Number(
        row.videos_without_tags ?? row.videosWithoutTags ?? 0,
      ),
      videos_without_creators: Number(
        row.videos_without_creators ?? row.videosWithoutCreators ?? 0,
      ),
      videos_without_ratings: Number(
        row.videos_without_ratings ?? row.videosWithoutRatings ?? 0,
      ),
      videos_without_thumbnails: Number(
        row.videos_without_thumbnails ?? row.videosWithoutThumbnails ?? 0,
      ),
      videos_without_storyboards: Number(
        row.videos_without_storyboards ?? row.videosWithoutStoryboards ?? 0,
      ),
      total_tags: Number(row.total_tags ?? row.totalTags ?? 0),
      total_creators: Number(row.total_creators ?? row.totalCreators ?? 0),
      total_studios: Number(row.total_studios ?? row.totalStudios ?? 0),
      total_playlists: Number(row.total_playlists ?? row.totalPlaylists ?? 0),
      top_tags: parseTopItems(row.top_tags ?? row.topTags),
      top_creators: parseTopItems(row.top_creators ?? row.topCreators),
      created_at: toISOString(row.created_at ?? row.createdAt),
    };
  }
}

export const contentStatsService = new ContentStatsService();
