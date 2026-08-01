import {
  and,
  asc,
  desc,
  eq,
  gte,
  ilike,
  lte,
  sql,
  type SQL,
} from "drizzle-orm";
import { db } from "@/config/drizzle";
import { conversionHistoryTable } from "@/database/schema";
import { RESOLUTION_BUCKETS } from "./conversion.buckets";
import type {
  ConversionHistoryEntry,
  ConversionHistoryFilters,
  ConversionHistoryListOptions,
  ConversionHistoryListResult,
  ConversionHistoryOverview,
  ConversionHistoryRecord,
  ConversionHistorySortDirection,
  ConversionHistorySortField,
} from "./conversion.types";

const SORT_COLUMNS = {
  created_at: conversionHistoryTable.createdAt,
  completed_at: conversionHistoryTable.completedAt,
  size_change_percent: conversionHistoryTable.sizeChangePercent,
  size_delta_bytes: conversionHistoryTable.sizeDeltaBytes,
  original_size_bytes: conversionHistoryTable.originalSizeBytes,
  output_size_bytes: conversionHistoryTable.outputSizeBytes,
  conversion_duration_ms: conversionHistoryTable.conversionDurationMs,
  source_bitrate: conversionHistoryTable.sourceBitrate,
  duration_seconds: conversionHistoryTable.durationSeconds,
} as const;

export class ConversionHistoryService {
  async createCompletedEntry(entry: ConversionHistoryEntry): Promise<void> {
    const sizeDeltaBytes = entry.outputSizeBytes - entry.originalSizeBytes;
    const sizeChangePercent =
      entry.originalSizeBytes > 0
        ? (sizeDeltaBytes / entry.originalSizeBytes) * 100
        : 0;

    const source = entry.sourceMetadata;
    const output = entry.outputMetadata;

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
      durationSeconds:
        source?.durationSeconds ?? output?.durationSeconds ?? null,
      sourceWidth: source?.width ?? null,
      sourceHeight: source?.height ?? null,
      sourceFps: source?.fps ?? null,
      sourceCodec: source?.codec ?? null,
      sourceAudioCodec: source?.audioCodec ?? null,
      sourceBitrate: source?.bitrate ?? null,
      outputWidth: output?.width ?? null,
      outputHeight: output?.height ?? null,
      outputFps: output?.fps ?? null,
      outputCodec: output?.codec ?? null,
      outputAudioCodec: output?.audioCodec ?? null,
      outputBitrate: output?.bitrate ?? null,
      profileVersion: entry.profileVersion,
      plannedVideoBitrate: entry.plannedVideoBitrate,
      plannedMaxBitrate: entry.plannedMaxBitrate,
      plannedQp: entry.plannedQp,
      effectiveResolution: entry.effectiveResolution,
      encodingMode: entry.encodingMode,
      startedAt: entry.startedAt,
      completedAt: entry.completedAt,
    });
  }

  async list(
    options?: ConversionHistoryListOptions,
  ): Promise<ConversionHistoryListResult> {
    const limit = Math.min(options?.limit ?? 50, 200);
    const offset = options?.offset ?? 0;
    const whereClause = this.buildWhereClause(options ?? {});

    const rows = await db
      .select()
      .from(conversionHistoryTable)
      .where(whereClause)
      .orderBy(...this.buildOrderBy(options?.sortBy, options?.sortDir))
      .limit(limit)
      .offset(offset);

    const [counted] = await db
      .select({ total: sql<number>`COUNT(*)::int` })
      .from(conversionHistoryTable)
      .where(whereClause);

    return {
      items: rows.map((row) => this.mapRow(row)),
      total: this.toNumber(counted?.total),
      limit,
      offset,
    };
  }

  /**
   * Every matching row, for in-memory aggregation. Insight metrics (medians,
   * crossover scans) do not decompose into a single SQL GROUP BY, and this
   * table stays in the low thousands for a personal library.
   */
  async listForAnalysis(
    filters: ConversionHistoryFilters,
    maxRows = 20_000,
  ): Promise<ConversionHistoryRecord[]> {
    const rows = await db
      .select()
      .from(conversionHistoryTable)
      .where(this.buildWhereClause(filters))
      .orderBy(desc(conversionHistoryTable.createdAt))
      .limit(maxRows);

    return rows.map((row) => this.mapRow(row));
  }

  async listPresets(): Promise<string[]> {
    const rows = await db
      .selectDistinct({ preset: conversionHistoryTable.preset })
      .from(conversionHistoryTable)
      .orderBy(asc(conversionHistoryTable.preset));

    return rows.map((row) => row.preset);
  }

  async listSourceCodecs(): Promise<string[]> {
    const rows = await db
      .selectDistinct({ codec: conversionHistoryTable.sourceCodec })
      .from(conversionHistoryTable)
      .orderBy(asc(conversionHistoryTable.sourceCodec));

    return rows
      .map((row) => row.codec)
      .filter((codec): codec is string => Boolean(codec));
  }

  async getOverview(
    filters?: ConversionHistoryFilters,
  ): Promise<ConversionHistoryOverview> {
    const whereClause = this.buildWhereClause(filters ?? {});

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

  private buildOrderBy(
    sortBy: ConversionHistorySortField | undefined,
    sortDir: ConversionHistorySortDirection | undefined,
  ): SQL<unknown>[] {
    const field = sortBy ?? "created_at";
    const column = SORT_COLUMNS[field];
    const direction = (sortDir ?? "desc") === "asc" ? "ASC" : "DESC";

    // NULLS LAST keeps rows with unknown metadata from hijacking the top of the
    // list when sorting by a column that was only backfilled where possible.
    const primary = sql`${column} ${sql.raw(direction)} NULLS LAST`;

    return field === "created_at"
      ? [primary, desc(conversionHistoryTable.id)]
      : [primary, desc(conversionHistoryTable.createdAt)];
  }

  private buildWhereClause(
    filters: ConversionHistoryFilters,
  ): SQL<unknown> | undefined {
    const conditions: SQL<unknown>[] = [];

    if (filters.videoId !== undefined) {
      conditions.push(
        eq(conversionHistoryTable.videoId, filters.videoId) as SQL<unknown>,
      );
    }

    const presets = filters.presets?.length
      ? filters.presets
      : filters.preset
        ? [filters.preset]
        : [];

    if (presets.length === 1) {
      conditions.push(
        eq(conversionHistoryTable.preset, presets[0]!) as SQL<unknown>,
      );
    } else if (presets.length > 1) {
      conditions.push(
        sql`${conversionHistoryTable.preset} = ANY(${presets})` as SQL<unknown>,
      );
    }

    if (filters.sourceCodec) {
      conditions.push(
        eq(
          conversionHistoryTable.sourceCodec,
          filters.sourceCodec,
        ) as SQL<unknown>,
      );
    }

    if (filters.resolution) {
      const bucket = RESOLUTION_BUCKETS.find(
        (entry) => entry.key === filters.resolution,
      );

      if (bucket) {
        const longEdge = sql`GREATEST(${conversionHistoryTable.sourceWidth}, ${conversionHistoryTable.sourceHeight})`;
        conditions.push(
          bucket.maxLongEdge === null
            ? (sql`${longEdge} >= ${bucket.minLongEdge}` as SQL<unknown>)
            : (sql`${longEdge} >= ${bucket.minLongEdge} AND ${longEdge} < ${bucket.maxLongEdge}` as SQL<unknown>),
        );
      }
    }

    if (filters.outcome === "saved") {
      conditions.push(
        sql`${conversionHistoryTable.sizeDeltaBytes} < 0` as SQL<unknown>,
      );
    } else if (filters.outcome === "increased") {
      conditions.push(
        sql`${conversionHistoryTable.sizeDeltaBytes} > 0` as SQL<unknown>,
      );
    } else if (filters.outcome === "unchanged") {
      conditions.push(
        sql`${conversionHistoryTable.sizeDeltaBytes} = 0` as SQL<unknown>,
      );
    }

    if (filters.search) {
      conditions.push(
        ilike(
          conversionHistoryTable.sourceFileName,
          `%${filters.search}%`,
        ) as SQL<unknown>,
      );
    }

    if (filters.createdAfter) {
      conditions.push(
        gte(
          conversionHistoryTable.createdAt,
          new Date(filters.createdAfter),
        ) as SQL<unknown>,
      );
    }

    if (filters.createdBefore) {
      conditions.push(
        lte(
          conversionHistoryTable.createdAt,
          new Date(filters.createdBefore),
        ) as SQL<unknown>,
      );
    }

    if (filters.minSizeChangePercent !== undefined) {
      conditions.push(
        gte(
          conversionHistoryTable.sizeChangePercent,
          filters.minSizeChangePercent,
        ) as SQL<unknown>,
      );
    }

    if (filters.maxSizeChangePercent !== undefined) {
      conditions.push(
        lte(
          conversionHistoryTable.sizeChangePercent,
          filters.maxSizeChangePercent,
        ) as SQL<unknown>,
      );
    }

    if (filters.minSourceBitrate !== undefined) {
      conditions.push(
        gte(
          conversionHistoryTable.sourceBitrate,
          filters.minSourceBitrate,
        ) as SQL<unknown>,
      );
    }

    if (filters.maxSourceBitrate !== undefined) {
      conditions.push(
        lte(
          conversionHistoryTable.sourceBitrate,
          filters.maxSourceBitrate,
        ) as SQL<unknown>,
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
    const durationSeconds = row.durationSeconds;
    const conversionDurationMs = row.conversionDurationMs;

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
      conversion_duration_ms: conversionDurationMs,
      duration_seconds: durationSeconds,
      source_width: row.sourceWidth,
      source_height: row.sourceHeight,
      source_fps: row.sourceFps,
      source_codec: row.sourceCodec,
      source_audio_codec: row.sourceAudioCodec,
      source_bitrate: row.sourceBitrate,
      output_width: row.outputWidth,
      output_height: row.outputHeight,
      output_fps: row.outputFps,
      output_codec: row.outputCodec,
      output_audio_codec: row.outputAudioCodec,
      output_bitrate: row.outputBitrate,
      profile_version: row.profileVersion,
      planned_video_bitrate: row.plannedVideoBitrate,
      planned_max_bitrate: row.plannedMaxBitrate,
      planned_qp: row.plannedQp,
      effective_resolution: row.effectiveResolution,
      encoding_mode:
        row.encodingMode === "hw" ||
        row.encodingMode === "sw_decode" ||
        row.encodingMode === "full_sw"
          ? row.encodingMode
          : null,
      encode_speed_ratio:
        durationSeconds && conversionDurationMs && conversionDurationMs > 0
          ? durationSeconds / (conversionDurationMs / 1000)
          : null,
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
