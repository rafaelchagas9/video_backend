import { db } from "@/config/drizzle";
import { and, eq, desc, sql } from "drizzle-orm";
import { triageProgressTable } from "@/database/schema";
import type {
  TriageProgress,
  SaveTriageProgressInput,
  GetTriageProgressInput,
  TriageStatistics,
  TriageBulkActionsInput,
  TriageBulkActionsResult,
} from "./triage.types";
import { env } from "@/config/env";
import { triageDemoService } from "./triage.demo.service";
import {
  videoRelationshipsService,
  emptyRelationshipCounts,
} from "@/modules/videos/videos.relationships.service";
import { ConflictError } from "@/utils/errors";

export class TriageService {
  async saveProgress(
    userId: number,
    input: SaveTriageProgressInput
  ): Promise<void> {
    if (env.DEMO_MODE) return triageDemoService.saveProgress(userId, input);
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
    input: GetTriageProgressInput
  ): Promise<TriageProgress | null> {
    if (env.DEMO_MODE) return triageDemoService.getProgress(userId, input);
    const { filterKey } = input;

    const results = await db
      .select()
      .from(triageProgressTable)
      .where(
        and(
          eq(triageProgressTable.userId, userId),
          eq(triageProgressTable.filterKey, filterKey)
        )
      );

    if (results.length === 0) return null;

    const row = results[0];
    return this.mapToSnakeCase(row);
  }

  async deleteProgress(userId: number, filterKey: string): Promise<void> {
    if (env.DEMO_MODE)
      return triageDemoService.deleteProgress(userId, filterKey);
    await db
      .delete(triageProgressTable)
      .where(
        and(
          eq(triageProgressTable.userId, userId),
          eq(triageProgressTable.filterKey, filterKey)
        )
      );
  }

  async listProgress(userId: number): Promise<TriageProgress[]> {
    if (env.DEMO_MODE) return triageDemoService.listProgress(userId);
    const results = await db
      .select()
      .from(triageProgressTable)
      .where(eq(triageProgressTable.userId, userId))
      .orderBy(desc(triageProgressTable.updatedAt));

    return results.map((row) => this.mapToSnakeCase(row));
  }

  async getStatistics(userId: number): Promise<TriageStatistics> {
    if (env.DEMO_MODE) return triageDemoService.getStatistics(userId);
    const [summary] = await db.execute(sql`
      SELECT COUNT(*) AS total,
             COUNT(vc.video_id) AS tagged,
             COUNT(vc.video_id) FILTER (WHERE v.indexed_at >= NOW() - INTERVAL '24 hours') AS indexed_24h,
             COUNT(vc.video_id) FILTER (WHERE v.indexed_at >= NOW() - INTERVAL '7 days') AS indexed_7d
      FROM videos v
      LEFT JOIN (SELECT DISTINCT video_id FROM video_creators) vc ON vc.video_id = v.id
      WHERE v.is_available = true
    `);
    const totalVideos = Number(summary.total);
    const videosWithCreators = Number(summary.tagged);
    const taggedPercentage = totalVideos
      ? Math.round((videosWithCreators / totalVideos) * 100)
      : 100;
    // These legacy response fields count indexed videos with creators; they are
    // not a tagging history (relationship creation timestamps are not stored).
    const tagged24h = Number(summary.indexed_24h);
    const tagged7d = Number(summary.indexed_7d);

    // Filter breakdown
    const filterBreakdownResult = await db.execute(sql`
      SELECT filter_key, COALESCE(total_count, 0) as total, processed_count,
             CASE WHEN COALESCE(total_count, 0) > 0
                  THEN ROUND((CAST(processed_count AS REAL) / total_count) * 100)
                  ELSE 0 END as percentage
      FROM triage_progress
      WHERE user_id = ${userId}
      ORDER BY updated_at DESC
      LIMIT 10
    `);
    const filterBreakdown = (filterBreakdownResult as any[]).map(
      (row: any) => ({
        filter_key: row.filter_key,
        total: Number(row.total),
        processed_count: Number(row.processed_count),
        percentage: Number(row.percentage),
      })
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
        avg_daily_rate: Math.round(tagged7d / 7),
      },
      filter_breakdown: filterBreakdown,
      top_directories: topDirectories,
    };
  }

  async applyBulkActions(
    input: TriageBulkActionsInput
  ): Promise<TriageBulkActionsResult> {
    if (env.DEMO_MODE) return triageDemoService.applyBulkActions(input);
    try {
      const { processed, details } = await videoRelationshipsService.apply(
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
