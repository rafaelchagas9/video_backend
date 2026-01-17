import { db } from "@/config/drizzle";
import { and, eq, desc, sql, inArray } from "drizzle-orm";
import {
  triageProgressTable,
  videoCreatorsTable,
  videoTagsTable,
  videoStudiosTable,
} from "@/database/schema";
import type {
  TriageProgress,
  SaveTriageProgressInput,
  GetTriageProgressInput,
  TriageStatistics,
  TriageBulkActionsInput,
  TriageBulkActionsResult,
} from "./triage.types";

export class TriageService {
  async saveProgress(
    userId: number,
    input: SaveTriageProgressInput,
  ): Promise<void> {
    const { filterKey, lastVideoId, processedCount, totalCount } = input;

    await db
      .insert(triageProgressTable)
      .values({
        userId,
        filterKey,
        lastVideoId: lastVideoId ?? null,
        processedCount,
        totalCount: totalCount ?? null,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [triageProgressTable.userId, triageProgressTable.filterKey],
        set: {
          lastVideoId: lastVideoId ?? null,
          processedCount,
          totalCount: totalCount ?? null,
          updatedAt: new Date(),
        },
      });
  }

  async getProgress(
    userId: number,
    input: GetTriageProgressInput,
  ): Promise<TriageProgress | null> {
    const { filterKey } = input;

    const results = await db
      .select()
      .from(triageProgressTable)
      .where(
        and(
          eq(triageProgressTable.userId, userId),
          eq(triageProgressTable.filterKey, filterKey),
        ),
      );

    if (results.length === 0) return null;

    const row = results[0];
    return this.mapToSnakeCase(row);
  }

  async deleteProgress(userId: number, filterKey: string): Promise<void> {
    await db
      .delete(triageProgressTable)
      .where(
        and(
          eq(triageProgressTable.userId, userId),
          eq(triageProgressTable.filterKey, filterKey),
        ),
      );
  }

  async listProgress(userId: number): Promise<TriageProgress[]> {
    const results = await db
      .select()
      .from(triageProgressTable)
      .where(eq(triageProgressTable.userId, userId))
      .orderBy(desc(triageProgressTable.updatedAt));

    return results.map((row) => this.mapToSnakeCase(row));
  }

  async getStatistics(): Promise<TriageStatistics> {
    // Total videos count
    const totalVideosResult = await db.execute(
      sql`SELECT COUNT(*) as count FROM videos WHERE is_available = true`,
    );
    const totalVideos = Number((totalVideosResult[0] as any).count || 0);

    // Videos with creators count
    const videosWithCreatorsResult = await db.execute(
      sql`SELECT COUNT(DISTINCT video_id) as count FROM video_creators`,
    );
    const videosWithCreators = Number(
      (videosWithCreatorsResult[0] as any).count || 0,
    );

    const taggedPercentage =
      totalVideos > 0
        ? Math.round((videosWithCreators / totalVideos) * 100)
        : 100;

    // Tagged in last 24 hours
    const tagged24hResult = await db.execute(sql`
      SELECT COUNT(*) as count FROM videos v
      WHERE v.is_available = true
      AND EXISTS (SELECT 1 FROM video_creators vc WHERE vc.video_id = v.id)
      AND v.indexed_at >= NOW() - INTERVAL '24 hours'
    `);
    const tagged24h = Number((tagged24hResult[0] as any).count || 0);

    // Tagged in last 7 days
    const tagged7dResult = await db.execute(sql`
      SELECT COUNT(*) as count FROM videos v
      WHERE v.is_available = true
      AND EXISTS (SELECT 1 FROM video_creators vc WHERE vc.video_id = v.id)
      AND v.indexed_at >= NOW() - INTERVAL '7 days'
    `);
    const tagged7d = Number((tagged7dResult[0] as any).count || 0);

    const avgDailyRate = Math.round(tagged24h / 1);

    // Filter breakdown
    const filterBreakdownResult = await db.execute(sql`
      SELECT filter_key, COALESCE(total_count, 0) as total, processed_count,
             CASE WHEN COALESCE(total_count, 0) > 0
                  THEN ROUND((CAST(processed_count AS REAL) / total_count) * 100)
                  ELSE 0 END as percentage
      FROM triage_progress
      ORDER BY updated_at DESC
      LIMIT 10
    `);
    const filterBreakdown = (filterBreakdownResult as any[]).map(
      (row: any) => ({
        filter_key: row.filter_key,
        total: Number(row.total),
        processed_count: Number(row.processed_count),
        percentage: Number(row.percentage),
      }),
    );

    // Top directories with untagged videos
    const topDirectoriesResult = await db.execute(sql`
      SELECT wd.id as directory_id, wd.path, COUNT(*) as untagged_count
      FROM videos v
      JOIN watched_directories wd ON v.directory_id = wd.id
      WHERE v.is_available = true
      AND NOT EXISTS (SELECT 1 FROM video_creators vc WHERE vc.video_id = v.id)
      GROUP BY wd.id, wd.path
      ORDER BY untagged_count DESC
      LIMIT 10
    `);
    const topDirectories = (topDirectoriesResult as any[]).map((row: any) => ({
      directory_id: Number(row.directory_id),
      path: row.path,
      untagged_count: Number(row.untagged_count),
    }));

    return {
      total_untagged_videos: totalVideos - videosWithCreators,
      total_videos: totalVideos,
      tagged_percentage: taggedPercentage,
      recent_progress: {
        last_24h_processed: tagged24h,
        last_7d_processed: tagged7d,
        avg_daily_rate: avgDailyRate,
      },
      filter_breakdown: filterBreakdown,
      top_directories: topDirectories,
    };
  }

  async applyBulkActions(
    input: TriageBulkActionsInput,
  ): Promise<TriageBulkActionsResult> {
    const { videoIds, actions } = input;

    if (videoIds.length === 0) {
      return {
        success: true,
        processed: 0,
        errors: 0,
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

    let errors = 0;
    let creatorsAdded = 0;
    let creatorsRemoved = 0;
    let tagsAdded = 0;
    let tagsRemoved = 0;
    let studiosAdded = 0;
    let studiosRemoved = 0;

    // Process each video
    for (const videoId of videoIds) {
      try {
        // Add creators
        if (actions.addCreatorIds && actions.addCreatorIds.length > 0) {
          for (const creatorId of actions.addCreatorIds) {
            try {
              await db
                .insert(videoCreatorsTable)
                .values({ videoId, creatorId })
                .onConflictDoNothing();
              creatorsAdded++;
            } catch (e: any) {
              if (e.code !== "23505") {
                // Not a unique violation
                errors++;
              }
            }
          }
        }

        // Remove creators
        if (actions.removeCreatorIds && actions.removeCreatorIds.length > 0) {
          await db
            .delete(videoCreatorsTable)
            .where(
              and(
                eq(videoCreatorsTable.videoId, videoId),
                inArray(videoCreatorsTable.creatorId, actions.removeCreatorIds),
              ),
            );
          creatorsRemoved += actions.removeCreatorIds.length;
        }

        // Add tags
        if (actions.addTagIds && actions.addTagIds.length > 0) {
          for (const tagId of actions.addTagIds) {
            try {
              await db
                .insert(videoTagsTable)
                .values({ videoId, tagId })
                .onConflictDoNothing();
              tagsAdded++;
            } catch (e: any) {
              if (e.code !== "23505") {
                errors++;
              }
            }
          }
        }

        // Remove tags
        if (actions.removeTagIds && actions.removeTagIds.length > 0) {
          await db
            .delete(videoTagsTable)
            .where(
              and(
                eq(videoTagsTable.videoId, videoId),
                inArray(videoTagsTable.tagId, actions.removeTagIds),
              ),
            );
          tagsRemoved += actions.removeTagIds.length;
        }

        // Add studios
        if (actions.addStudioIds && actions.addStudioIds.length > 0) {
          for (const studioId of actions.addStudioIds) {
            try {
              await db
                .insert(videoStudiosTable)
                .values({ videoId, studioId })
                .onConflictDoNothing();
              studiosAdded++;
            } catch (e: any) {
              if (e.code !== "23505") {
                errors++;
              }
            }
          }
        }

        // Remove studios
        if (actions.removeStudioIds && actions.removeStudioIds.length > 0) {
          await db
            .delete(videoStudiosTable)
            .where(
              and(
                eq(videoStudiosTable.videoId, videoId),
                inArray(videoStudiosTable.studioId, actions.removeStudioIds),
              ),
            );
          studiosRemoved += actions.removeStudioIds.length;
        }
      } catch (e) {
        errors++;
      }
    }

    return {
      success: errors === 0,
      processed: videoIds.length,
      errors,
      details: {
        creators_added: creatorsAdded,
        creators_removed: creatorsRemoved,
        tags_added: tagsAdded,
        tags_removed: tagsRemoved,
        studios_added: studiosAdded,
        studios_removed: studiosRemoved,
      },
    };
  }

  private mapToSnakeCase(row: any): TriageProgress {
    return {
      id: row.id,
      user_id: row.userId,
      filter_key: row.filterKey,
      last_video_id: row.lastVideoId,
      processed_count: row.processedCount,
      total_count: row.totalCount,
      created_at:
        row.createdAt instanceof Date
          ? row.createdAt.toISOString()
          : row.createdAt,
      updated_at:
        row.updatedAt instanceof Date
          ? row.updatedAt.toISOString()
          : row.updatedAt,
    };
  }
}

export const triageService = new TriageService();
