import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { db } from "@/config/drizzle";
import { conversionHistoryTable } from "@/database/schema";
import type {
  ConversionHistoryEntry,
  ConversionHistoryOverview,
  ConversionHistoryRecord,
} from "./conversion.types";

export class ConversionHistoryService {
  async createCompletedEntry(entry: ConversionHistoryEntry): Promise<void> {
    const sizeDeltaBytes = entry.outputSizeBytes - entry.originalSizeBytes;
    const sizeChangePercent =
      entry.originalSizeBytes > 0
        ? (sizeDeltaBytes / entry.originalSizeBytes) * 100
        : 0;

    await db.insert(conversionHistoryTable).values({
      conversionJobId: entry.conversionJobId,
      videoId: entry.videoId,
      sourceFilePath: entry.sourceFilePath,
      sourceFileName: entry.sourceFileName,
      outputFilePath: entry.outputFilePath,
      preset: entry.preset,
      codec: entry.codec,
      targetResolution: entry.targetResolution,
      ffmpegCommand: entry.ffmpegCommand,
      originalSizeBytes: entry.originalSizeBytes,
      outputSizeBytes: entry.outputSizeBytes,
      sizeDeltaBytes,
      sizeChangePercent,
      conversionDurationMs: entry.conversionDurationMs,
      startedAt: entry.startedAt,
      completedAt: entry.completedAt,
    });
  }

  async list(options?: {
    limit?: number;
    offset?: number;
    videoId?: number;
    preset?: string;
  }): Promise<ConversionHistoryRecord[]> {
    const limit = Math.min(options?.limit ?? 50, 200);
    const offset = options?.offset ?? 0;

    const whereClause = this.buildWhereClause({
      videoId: options?.videoId,
      preset: options?.preset,
    });

    const rows = await db
      .select()
      .from(conversionHistoryTable)
      .where(whereClause)
      .orderBy(desc(conversionHistoryTable.createdAt))
      .limit(limit)
      .offset(offset);

    return rows.map((row) => this.mapRow(row));
  }

  async getOverview(options?: {
    videoId?: number;
    preset?: string;
  }): Promise<ConversionHistoryOverview> {
    const whereClause = this.buildWhereClause({
      videoId: options?.videoId,
      preset: options?.preset,
    });

    const [stats] = await db
      .select({
        totalConversions: sql`COALESCE(COUNT(${conversionHistoryTable.id}), 0)`,
        totalOriginalSizeBytes: sql`COALESCE(SUM(${conversionHistoryTable.originalSizeBytes}), 0)`,
        totalOutputSizeBytes: sql`COALESCE(SUM(${conversionHistoryTable.outputSizeBytes}), 0)`,
        totalSizeDeltaBytes: sql`COALESCE(SUM(${conversionHistoryTable.sizeDeltaBytes}), 0)`,
        totalSavedBytes: sql`COALESCE(SUM(CASE WHEN ${conversionHistoryTable.sizeDeltaBytes} < 0 THEN ABS(${conversionHistoryTable.sizeDeltaBytes}) ELSE 0 END), 0)`,
        totalIncreasedBytes: sql`COALESCE(SUM(CASE WHEN ${conversionHistoryTable.sizeDeltaBytes} > 0 THEN ${conversionHistoryTable.sizeDeltaBytes} ELSE 0 END), 0)`,
        savedCount: sql`COALESCE(SUM(CASE WHEN ${conversionHistoryTable.sizeDeltaBytes} < 0 THEN 1 ELSE 0 END), 0)`,
        increasedCount: sql`COALESCE(SUM(CASE WHEN ${conversionHistoryTable.sizeDeltaBytes} > 0 THEN 1 ELSE 0 END), 0)`,
        unchangedCount: sql`COALESCE(SUM(CASE WHEN ${conversionHistoryTable.sizeDeltaBytes} = 0 THEN 1 ELSE 0 END), 0)`,
        avgSizeChangePercent: sql`COALESCE(AVG(${conversionHistoryTable.sizeChangePercent}), 0)::float`,
        avgConversionDurationMs: sql`COALESCE(AVG(${conversionHistoryTable.conversionDurationMs}), 0)::float`,
      })
      .from(conversionHistoryTable)
      .where(whereClause);

    return {
      total_conversions: this.toNumber(stats?.totalConversions),
      total_original_size_bytes: this.toNumber(stats?.totalOriginalSizeBytes),
      total_output_size_bytes: this.toNumber(stats?.totalOutputSizeBytes),
      total_size_delta_bytes: this.toNumber(stats?.totalSizeDeltaBytes),
      total_saved_bytes: this.toNumber(stats?.totalSavedBytes),
      total_increased_bytes: this.toNumber(stats?.totalIncreasedBytes),
      saved_count: this.toNumber(stats?.savedCount),
      increased_count: this.toNumber(stats?.increasedCount),
      unchanged_count: this.toNumber(stats?.unchangedCount),
      avg_size_change_percent: this.toNumber(stats?.avgSizeChangePercent),
      avg_conversion_duration_ms: Math.round(
        this.toNumber(stats?.avgConversionDurationMs),
      ),
    };
  }

  private buildWhereClause(filters: {
    videoId?: number;
    preset?: string;
  }): SQL<unknown> | undefined {
    const conditions: SQL<unknown>[] = [];

    if (filters.videoId !== undefined) {
      conditions.push(
        eq(conversionHistoryTable.videoId, filters.videoId) as SQL<unknown>,
      );
    }

    if (filters.preset) {
      conditions.push(
        eq(conversionHistoryTable.preset, filters.preset) as SQL<unknown>,
      );
    }

    if (conditions.length === 0) {
      return undefined;
    }

    if (conditions.length === 1) {
      return conditions[0];
    }

    return and(...conditions);
  }

  private mapRow(
    row: typeof conversionHistoryTable.$inferSelect,
  ): ConversionHistoryRecord {
    return {
      id: row.id,
      conversion_job_id: row.conversionJobId,
      video_id: row.videoId,
      source_video_deleted: row.videoId === null,
      source_file_path: row.sourceFilePath,
      source_file_name: row.sourceFileName,
      output_file_path: row.outputFilePath,
      preset: row.preset,
      codec: row.codec,
      target_resolution: row.targetResolution,
      ffmpeg_command: row.ffmpegCommand,
      original_size_bytes: this.toNumber(row.originalSizeBytes),
      output_size_bytes: this.toNumber(row.outputSizeBytes),
      size_delta_bytes: this.toNumber(row.sizeDeltaBytes),
      size_change_percent: row.sizeChangePercent,
      conversion_duration_ms: row.conversionDurationMs,
      started_at: row.startedAt ? row.startedAt.toISOString() : null,
      completed_at: row.completedAt ? row.completedAt.toISOString() : null,
      created_at: row.createdAt.toISOString(),
    };
  }

  private toNumber(value: unknown): number {
    if (typeof value === "number") {
      return value;
    }

    if (typeof value === "bigint") {
      return Number(value);
    }

    if (typeof value === "string") {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : 0;
    }

    return 0;
  }
}

export const conversionHistoryService = new ConversionHistoryService();
