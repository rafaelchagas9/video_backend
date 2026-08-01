/**
 * Conversion insights
 *
 * Turns the raw conversion history into "should I keep using this preset?"
 * answers: how each preset performed, which source characteristics predict a
 * good result, and where encode time was spent without saving storage.
 */
import { getPreset } from "@/config/presets";
import {
  BITRATE_BUCKETS,
  FPS_BUCKETS,
  RESOLUTION_BUCKETS,
  UNKNOWN_BUCKET_KEY,
  UNKNOWN_BUCKET_LABEL,
  classifyBitrate,
  classifyFps,
  classifyResolution,
} from "./conversion.buckets";
import { conversionHistoryService } from "./conversion.history.service";
import type {
  ConversionHistoryFilters,
  ConversionHistoryRecord,
  ConversionInsightBreakEven,
  ConversionInsightExtreme,
  ConversionInsightGroup,
  ConversionInsightRecommendation,
  ConversionInsightTimelinePoint,
  ConversionInsights,
} from "./conversion.types";

/** Minimum rows before a slice is allowed to drive a recommendation. */
const MIN_SAMPLE_FOR_ADVICE = 5;
/** Higher bar for advice that ranks slices against each other. */
const MIN_SAMPLE_FOR_TREND = 20;
/** Minimum rows per 1 Mbps band when scanning for the break-even point. */
const MIN_SAMPLE_PER_BAND = 3;
const MAX_SCAN_MBPS = 60;
const TOP_N = 5;

const EFFICIENT_SOURCE_CODECS = new Set(["av1", "hevc", "h265", "vp9"]);

export class ConversionInsightsService {
  async getInsights(
    filters: ConversionHistoryFilters = {},
  ): Promise<ConversionInsights> {
    const rows = await conversionHistoryService.listForAnalysis(filters);

    return this.analyze(rows);
  }

  /** Pure aggregation, split out so it can be reused for synthetic datasets. */
  analyze(rows: ConversionHistoryRecord[]): ConversionInsights {
    const breakEven = this.buildBreakEvens(rows);

    return {
      coverage: {
        total_conversions: rows.length,
        analyzed: rows.length,
        with_duration: rows.filter((row) => (row.duration_seconds ?? 0) > 0)
          .length,
        with_source_bitrate: rows.filter((row) => (row.source_bitrate ?? 0) > 0)
          .length,
        with_source_resolution: rows.filter(
          (row) => row.source_width !== null || row.source_height !== null,
        ).length,
        with_source_codec: rows.filter((row) => row.source_codec !== null)
          .length,
      },
      by_preset: this.groupByKey(rows, (row) => ({
        key: row.preset,
        label: this.presetLabel(row.preset),
      })).sort((a, b) => b.conversions - a.conversions),
      by_source_bitrate: this.groupByBuckets(rows, BITRATE_BUCKETS, (row) =>
        classifyBitrate(row.source_bitrate),
      ),
      by_source_resolution: this.groupByBuckets(
        rows,
        RESOLUTION_BUCKETS,
        (row) => classifyResolution(row.source_width, row.source_height),
      ),
      by_source_codec: this.groupByKey(rows, (row) =>
        row.source_codec
          ? { key: row.source_codec, label: row.source_codec.toUpperCase() }
          : null,
      ).sort((a, b) => b.conversions - a.conversions),
      by_source_fps: this.groupByBuckets(rows, FPS_BUCKETS, (row) =>
        classifyFps(row.source_fps),
      ),
      by_month: this.buildTimeline(rows),
      break_even: breakEven,
      best: this.topBy(rows, "best"),
      worst: this.topBy(rows, "worst"),
      recommendations: this.buildRecommendations(rows, breakEven),
    };
  }

  private presetLabel(presetId: string): string {
    return getPreset(presetId)?.name ?? presetId;
  }

  private groupByKey(
    rows: ConversionHistoryRecord[],
    resolve: (
      row: ConversionHistoryRecord,
    ) => { key: string; label: string } | null,
  ): ConversionInsightGroup[] {
    const buckets = new Map<
      string,
      { label: string; rows: ConversionHistoryRecord[] }
    >();

    for (const row of rows) {
      const resolved = resolve(row);
      const key = resolved?.key ?? UNKNOWN_BUCKET_KEY;
      const label = resolved?.label ?? UNKNOWN_BUCKET_LABEL;
      const bucket = buckets.get(key);

      if (bucket) {
        bucket.rows.push(row);
      } else {
        buckets.set(key, { label, rows: [row] });
      }
    }

    return Array.from(buckets.entries()).map(([key, bucket]) =>
      this.buildGroup(key, bucket.label, bucket.rows),
    );
  }

  private groupByBuckets<T extends { key: string; label: string }>(
    rows: ConversionHistoryRecord[],
    definitions: readonly T[],
    classify: (row: ConversionHistoryRecord) => T | null,
  ): ConversionInsightGroup[] {
    const buckets = new Map<string, ConversionHistoryRecord[]>();

    for (const row of rows) {
      const key = classify(row)?.key ?? UNKNOWN_BUCKET_KEY;
      const existing = buckets.get(key);

      if (existing) {
        existing.push(row);
      } else {
        buckets.set(key, [row]);
      }
    }

    const ordered: ConversionInsightGroup[] = [];

    for (const definition of definitions) {
      const bucketRows = buckets.get(definition.key);
      if (bucketRows?.length) {
        ordered.push(
          this.buildGroup(definition.key, definition.label, bucketRows),
        );
      }
    }

    const unknownRows = buckets.get(UNKNOWN_BUCKET_KEY);
    if (unknownRows?.length) {
      ordered.push(
        this.buildGroup(UNKNOWN_BUCKET_KEY, UNKNOWN_BUCKET_LABEL, unknownRows),
      );
    }

    return ordered;
  }

  private buildGroup(
    key: string,
    label: string,
    rows: ConversionHistoryRecord[],
  ): ConversionInsightGroup {
    return {
      key,
      label,
      conversions: rows.length,
      total_original_size_bytes: this.sum(
        rows,
        (row) => row.original_size_bytes,
      ),
      total_output_size_bytes: this.sum(rows, (row) => row.output_size_bytes),
      total_saved_bytes: this.sum(rows, (row) =>
        row.size_delta_bytes < 0 ? -row.size_delta_bytes : 0,
      ),
      total_increased_bytes: this.sum(rows, (row) =>
        row.size_delta_bytes > 0 ? row.size_delta_bytes : 0,
      ),
      increased_count: rows.filter((row) => row.size_delta_bytes > 0).length,
      avg_size_change_percent: this.mean(
        rows.map((row) => row.size_change_percent),
      ),
      median_size_change_percent: this.median(
        rows.map((row) => row.size_change_percent),
      ),
      avg_source_bitrate: this.meanOrNull(
        rows.map((row) => row.source_bitrate).filter(this.isPositive),
      ),
      avg_output_bitrate: this.meanOrNull(
        rows.map((row) => row.output_bitrate).filter(this.isPositive),
      ),
      avg_conversion_duration_ms: this.meanOrNull(
        rows.map((row) => row.conversion_duration_ms).filter(this.isPositive),
      ),
      avg_encode_speed_ratio: this.meanOrNull(
        rows.map((row) => row.encode_speed_ratio).filter(this.isPositive),
      ),
    };
  }

  private buildTimeline(
    rows: ConversionHistoryRecord[],
  ): ConversionInsightTimelinePoint[] {
    const periods = new Map<string, ConversionHistoryRecord[]>();

    for (const row of rows) {
      const period = row.created_at.slice(0, 7);
      const existing = periods.get(period);

      if (existing) {
        existing.push(row);
      } else {
        periods.set(period, [row]);
      }
    }

    return Array.from(periods.entries())
      .map(([period, periodRows]) => ({
        period,
        conversions: periodRows.length,
        total_original_size_bytes: this.sum(
          periodRows,
          (row) => row.original_size_bytes,
        ),
        total_output_size_bytes: this.sum(
          periodRows,
          (row) => row.output_size_bytes,
        ),
        total_saved_bytes: this.sum(periodRows, (row) =>
          row.size_delta_bytes < 0 ? -row.size_delta_bytes : 0,
        ),
        avg_size_change_percent: this.mean(
          periodRows.map((row) => row.size_change_percent),
        ),
      }))
      .sort((a, b) => a.period.localeCompare(b.period));
  }

  /**
   * Finds the source bitrate above which conversions reliably shrink files.
   *
   * The encoder lands on a roughly fixed output bitrate, so the outcome is
   * mostly decided by how far the source sits above that. Scanning 1 Mbps bands
   * for the lowest point where every band above it still shrinks gives a
   * threshold that can be read straight off the data.
   */
  private computeBreakEven(
    rows: ConversionHistoryRecord[],
    withBitrate: ConversionHistoryRecord[],
    resolutionKey: string,
    resolutionLabel: string,
  ): ConversionInsightBreakEven | null {
    if (withBitrate.length < MIN_SAMPLE_FOR_ADVICE) {
      return null;
    }

    const typicalOutputBitrate = this.medianOrNull(
      rows.map((row) => row.output_bitrate).filter(this.isPositive),
    );

    const bands = new Map<number, ConversionHistoryRecord[]>();
    for (const row of withBitrate) {
      const band = Math.floor((row.source_bitrate ?? 0) / 1_000_000);
      const existing = bands.get(band);

      if (existing) {
        existing.push(row);
      } else {
        bands.set(band, [row]);
      }
    }

    let crossoverMbps: number | null = null;
    const populatedBands = Array.from(bands.entries())
      .filter(
        ([band, bandRows]) =>
          band >= 0 &&
          band <= MAX_SCAN_MBPS &&
          bandRows.length >= MIN_SAMPLE_PER_BAND,
      )
      .map(([band]) => band)
      .sort((a, b) => a - b);

    for (const candidate of populatedBands) {
      let holds = false;

      for (const band of populatedBands) {
        if (band < candidate) continue;
        const bandRows = bands.get(band)!;

        if (this.mean(bandRows.map((row) => row.size_change_percent)) >= 0) {
          holds = false;
          break;
        }

        holds = true;
      }

      if (holds) {
        crossoverMbps = candidate;
        break;
      }
    }

    if (crossoverMbps === null) {
      return {
        resolution_key: resolutionKey,
        resolution_label: resolutionLabel,
        typical_output_bitrate: typicalOutputBitrate,
        crossover_bitrate: null,
        below_count: 0,
        below_avg_size_change_percent: null,
        below_wasted_bytes: 0,
        above_count: 0,
        above_avg_size_change_percent: null,
        above_saved_bytes: 0,
      };
    }

    const threshold = crossoverMbps * 1_000_000;
    const below = withBitrate.filter(
      (row) => (row.source_bitrate ?? 0) < threshold,
    );
    const above = withBitrate.filter(
      (row) => (row.source_bitrate ?? 0) >= threshold,
    );

    return {
      resolution_key: resolutionKey,
      resolution_label: resolutionLabel,
      typical_output_bitrate: typicalOutputBitrate,
      crossover_bitrate: threshold,
      below_count: below.length,
      below_avg_size_change_percent: below.length
        ? this.mean(below.map((row) => row.size_change_percent))
        : null,
      below_wasted_bytes: this.sum(below, (row) =>
        row.size_delta_bytes > 0 ? row.size_delta_bytes : 0,
      ),
      above_count: above.length,
      above_avg_size_change_percent: above.length
        ? this.mean(above.map((row) => row.size_change_percent))
        : null,
      above_saved_bytes: this.sum(above, (row) =>
        row.size_delta_bytes < 0 ? -row.size_delta_bytes : 0,
      ),
    };
  }

  private buildBreakEvens(
    rows: ConversionHistoryRecord[],
  ): ConversionInsightBreakEven[] {
    const grouped = new Map<
      string,
      { label: string; rows: ConversionHistoryRecord[] }
    >();

    for (const row of rows) {
      const resolution = classifyResolution(
        row.output_width,
        row.output_height,
      );
      if (!resolution) continue;

      const group = grouped.get(resolution.key);
      if (group) {
        group.rows.push(row);
      } else {
        grouped.set(resolution.key, {
          label: resolution.label,
          rows: [row],
        });
      }
    }

    const breakEvens: ConversionInsightBreakEven[] = [];
    for (const resolution of RESOLUTION_BUCKETS) {
      const group = grouped.get(resolution.key);
      if (!group) continue;

      const withBitrate = group.rows.filter(
        (row) => (row.source_bitrate ?? 0) > 0,
      );
      const breakEven = this.computeBreakEven(
        group.rows,
        withBitrate,
        resolution.key,
        group.label,
      );
      if (breakEven) {
        breakEvens.push(breakEven);
      }
    }

    return breakEvens;
  }

  private topBy(
    rows: ConversionHistoryRecord[],
    mode: "best" | "worst",
  ): ConversionInsightExtreme[] {
    return [...rows]
      .sort((a, b) =>
        mode === "best"
          ? a.size_change_percent - b.size_change_percent
          : b.size_change_percent - a.size_change_percent,
      )
      .slice(0, TOP_N)
      .map((row) => ({
        id: row.id,
        preset: row.preset,
        profile_version: row.profile_version,
        effective_resolution: row.effective_resolution,
        source_bitrate: row.source_bitrate,
        output_bitrate: row.output_bitrate,
        original_size_bytes: row.original_size_bytes,
        output_size_bytes: row.output_size_bytes,
        size_delta_bytes: row.size_delta_bytes,
        size_change_percent: row.size_change_percent,
        conversion_duration_ms: row.conversion_duration_ms,
        created_at: row.created_at,
      }));
  }

  private buildRecommendations(
    rows: ConversionHistoryRecord[],
    breakEven: ConversionInsightBreakEven[],
  ): ConversionInsightRecommendation[] {
    const recommendations: ConversionInsightRecommendation[] = [];

    if (rows.length < MIN_SAMPLE_FOR_ADVICE) {
      return recommendations;
    }

    for (const entry of breakEven) {
      if (
        !entry.crossover_bitrate ||
        entry.below_count < MIN_SAMPLE_FOR_ADVICE ||
        entry.below_avg_size_change_percent === null ||
        entry.below_avg_size_change_percent <= -10
      ) {
        continue;
      }

      const mbps = entry.crossover_bitrate / 1_000_000;
      recommendations.push({
        id: `skip-low-bitrate-sources-${entry.resolution_key}`,
        severity:
          entry.below_avg_size_change_percent >= 0 ? "critical" : "warning",
        title:
          `Skip ${entry.resolution_label} conversions below ` +
          this.formatMbps(entry.crossover_bitrate),
        detail:
          `${entry.below_count} ${entry.resolution_label} conversions started from sources under ${mbps} Mbps and averaged ` +
          `${this.formatPercent(entry.below_avg_size_change_percent)}. Above that threshold conversions ` +
          `averaged ${this.formatPercent(entry.above_avg_size_change_percent ?? 0)}.`,
        metric:
          entry.below_wasted_bytes > 0
            ? `${this.formatBytes(entry.below_wasted_bytes)} added`
            : null,
      });
    }

    const dominantPreset = this.dominantPreset(rows);
    const typicalOutput = this.medianOrNull(
      rows.map((row) => row.output_bitrate).filter(this.isPositive),
    );

    if (dominantPreset && typicalOutput) {
      const preset = getPreset(dominantPreset);
      const capMbps = preset?.maxBitrate
        ? Number.parseInt(preset.maxBitrate.replace("M", ""), 10)
        : null;

      if (capMbps && typicalOutput >= capMbps * 1_000_000 * 0.8) {
        recommendations.push({
          id: "bitrate-cap-binding",
          severity: "info",
          title: "Outputs are pinned to the preset bitrate ceiling",
          detail:
            `Encodes with ${preset?.name ?? dominantPreset} land at a median ${this.formatMbps(typicalOutput)} ` +
            `overall (video plus audio and container), against its ${capMbps} Mbps video ceiling — the bitrate ` +
            `cap, not the QP ${preset?.qp ?? "?"} quality target, is deciding output size. Lower the ceiling ` +
            `for more savings, raise it for more quality.`,
          metric: `${this.formatMbps(typicalOutput)} median`,
        });
      }
    }

    for (const group of this.groupByKey(rows, (row) =>
      row.source_codec
        ? { key: row.source_codec, label: row.source_codec.toUpperCase() }
        : null,
    )) {
      if (
        group.conversions >= MIN_SAMPLE_FOR_ADVICE &&
        EFFICIENT_SOURCE_CODECS.has(group.key.toLowerCase()) &&
        group.avg_size_change_percent > -15
      ) {
        recommendations.push({
          id: `efficient-source-codec-${group.key}`,
          severity: "warning",
          title: `Re-encoding ${group.label} sources returns little`,
          detail:
            `${group.conversions} conversions came from ${group.label} sources and averaged ` +
            `${this.formatPercent(group.avg_size_change_percent)}. Already-efficient codecs are usually worth leaving alone.`,
          metric: this.formatPercent(group.avg_size_change_percent),
        });
      }
    }

    const resolutionGroups = this.groupByBuckets(
      rows,
      RESOLUTION_BUCKETS,
      (row) => classifyResolution(row.source_width, row.source_height),
    ).filter(
      (group) =>
        group.key !== UNKNOWN_BUCKET_KEY &&
        group.conversions >= MIN_SAMPLE_FOR_TREND,
    );

    // Weighted by what it actually freed, so a handful of tiny files cannot
    // present themselves as the best thing to queue next.
    const totalSaved = this.sum(rows, (row) =>
      row.size_delta_bytes < 0 ? -row.size_delta_bytes : 0,
    );
    const bestResolution = resolutionGroups
      .slice()
      .sort((a, b) => a.avg_size_change_percent - b.avg_size_change_percent)[0];

    if (
      bestResolution &&
      bestResolution.avg_size_change_percent < -40 &&
      totalSaved > 0 &&
      bestResolution.total_saved_bytes / totalSaved > 0.1
    ) {
      recommendations.push({
        id: `prioritise-${bestResolution.key}`,
        severity: "info",
        title: `${bestResolution.label} sources give the biggest wins`,
        detail:
          `${bestResolution.conversions} conversions from ${bestResolution.label} sources averaged ` +
          `${this.formatPercent(bestResolution.avg_size_change_percent)} and freed ` +
          `${this.formatBytes(bestResolution.total_saved_bytes)}. Queue these first.`,
        metric: this.formatPercent(bestResolution.avg_size_change_percent),
      });
    }

    const presetGroups = this.groupByKey(rows, (row) => ({
      key: row.preset,
      label: this.presetLabel(row.preset),
    })).filter((group) => group.conversions >= 10);

    if (presetGroups.length >= 2) {
      const ranked = presetGroups
        .slice()
        .sort((a, b) => a.avg_size_change_percent - b.avg_size_change_percent);
      const best = ranked[0]!;
      const worst = ranked[ranked.length - 1]!;

      if (best.avg_size_change_percent < worst.avg_size_change_percent - 10) {
        recommendations.push({
          id: "preset-comparison",
          severity: "info",
          title: `${best.label} is outperforming ${worst.label}`,
          detail:
            `${best.label} averaged ${this.formatPercent(best.avg_size_change_percent)} over ${best.conversions} ` +
            `conversions versus ${this.formatPercent(worst.avg_size_change_percent)} over ${worst.conversions} ` +
            `for ${worst.label}. Note that preset choice and source mix are correlated here.`,
          metric: null,
        });
      }
    }

    const increased = rows.filter((row) => row.size_delta_bytes > 0);
    if (increased.length > 0) {
      const wastedBytes = this.sum(increased, (row) => row.size_delta_bytes);
      const wastedMs = this.sum(
        increased,
        (row) => row.conversion_duration_ms ?? 0,
      );

      recommendations.push({
        id: "conversions-that-grew",
        severity: increased.length / rows.length > 0.1 ? "warning" : "info",
        title: `${increased.length} conversions produced a bigger file`,
        detail:
          `They added ${this.formatBytes(wastedBytes)} of storage and used ` +
          `${this.formatHours(wastedMs)} of encode time. Filter the history by "Grew" to review them.`,
        metric: `+${this.formatBytes(wastedBytes)}`,
      });
    }

    const severityOrder = { critical: 0, warning: 1, info: 2 } as const;
    return recommendations.sort(
      (a, b) => severityOrder[a.severity] - severityOrder[b.severity],
    );
  }

  private dominantPreset(rows: ConversionHistoryRecord[]): string | null {
    const counts = new Map<string, number>();

    for (const row of rows) {
      counts.set(row.preset, (counts.get(row.preset) ?? 0) + 1);
    }

    let dominant: string | null = null;
    let max = 0;

    for (const [preset, count] of counts) {
      if (count > max) {
        max = count;
        dominant = preset;
      }
    }

    return dominant;
  }

  private isPositive = (value: number | null): value is number =>
    value !== null && value > 0;

  private sum<T>(rows: T[], select: (row: T) => number): number {
    return rows.reduce((total, row) => total + select(row), 0);
  }

  private mean(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((total, value) => total + value, 0) / values.length;
  }

  private meanOrNull(values: number[]): number | null {
    return values.length === 0 ? null : this.mean(values);
  }

  private median(values: number[]): number {
    return this.medianOrNull(values) ?? 0;
  }

  private medianOrNull(values: number[]): number | null {
    if (values.length === 0) return null;

    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);

    return sorted.length % 2 === 0
      ? (sorted[middle - 1]! + sorted[middle]!) / 2
      : sorted[middle]!;
  }

  private formatPercent(value: number): string {
    return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
  }

  private formatMbps(bitrate: number): string {
    return `${(bitrate / 1_000_000).toFixed(1)} Mbps`;
  }

  private formatBytes(bytes: number): string {
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = Math.abs(bytes);
    let unit = 0;

    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }

    return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
  }

  private formatHours(ms: number): string {
    const hours = ms / 3_600_000;

    if (hours < 1) {
      return `${Math.round(ms / 60_000)} min`;
    }

    return `${hours.toFixed(1)} h`;
  }
}

export const conversionInsightsService = new ConversionInsightsService();
