import { createHash } from "node:crypto";
import type { SystemBookmarkCategoryKey as NudityCategory } from "@/modules/bookmarks/bookmark-categories.constants";
import type { ContentAnalysisEventDraft } from "./content-analysis.types";

export interface TimestampedNudityFinding {
  timestampSeconds: number;
  category: NudityCategory;
  score: number;
  providerLabel?: string;
}

export interface NudityCategoryThreshold {
  entryScore: number;
  exitScore: number;
}

export interface NudityCondensationConfig {
  generationKeyPrefix: string;
  videoDurationSeconds: number;
  selectedCategories: readonly NudityCategory[];
  thresholds: Readonly<
    Partial<Record<NudityCategory, NudityCategoryThreshold>>
  >;
  defaultThreshold: NudityCategoryThreshold;
  confirmationCount: number;
  confirmationWindowSeconds: number;
  negativeToleranceSeconds: number;
  mergeGapSeconds: number;
  preRollSeconds: number;
  postRollSeconds: number;
}

interface CategorySpan {
  category: NudityCategory;
  startSeconds: number;
  endSeconds: number;
  samples: TimestampedNudityFinding[];
}

interface EpisodeSpan {
  startSeconds: number;
  endSeconds: number;
  samples: TimestampedNudityFinding[];
}

function eventGenerationKey(prefix: string, span: EpisodeSpan): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        span.startSeconds,
        span.endSeconds,
        span.samples.map((sample) => [
          sample.timestampSeconds,
          sample.category,
          sample.score,
          sample.providerLabel ?? null,
        ]),
      ])
    )
    .digest("hex")
    .slice(0, 24);
  return `${prefix}:episode:${digest}`;
}

function buildCategorySpans(
  category: NudityCategory,
  findings: TimestampedNudityFinding[],
  threshold: NudityCategoryThreshold,
  config: NudityCondensationConfig
): CategorySpan[] {
  const spans: CategorySpan[] = [];
  let pending: TimestampedNudityFinding[] = [];
  let active: CategorySpan | null = null;

  const closeActive = () => {
    if (active !== null) spans.push(active);
    active = null;
  };

  for (const finding of findings) {
    const qualifiesForExit = finding.score >= threshold.exitScore;
    if (
      active !== null &&
      finding.timestampSeconds - active.endSeconds >
        config.negativeToleranceSeconds
    ) {
      closeActive();
    }

    if (active !== null) {
      if (qualifiesForExit) {
        active.endSeconds = finding.timestampSeconds;
        active.samples.push(finding);
      }
      continue;
    }

    if (!qualifiesForExit) {
      pending = [];
      continue;
    }

    pending.push(finding);
    pending = pending.filter(
      (candidate) =>
        finding.timestampSeconds - candidate.timestampSeconds <=
        config.confirmationWindowSeconds
    );

    if (
      finding.score >= threshold.entryScore ||
      pending.length >= config.confirmationCount
    ) {
      active = {
        category,
        startSeconds: pending[0].timestampSeconds,
        endSeconds: finding.timestampSeconds,
        samples: [...pending],
      };
      pending = [];
    }
  }

  closeActive();
  return spans;
}

function compareSamples(
  left: TimestampedNudityFinding,
  right: TimestampedNudityFinding
): number {
  return (
    right.score - left.score ||
    left.timestampSeconds - right.timestampSeconds ||
    left.category.localeCompare(right.category) ||
    (left.providerLabel ?? "").localeCompare(right.providerLabel ?? "")
  );
}

function mergeSpans(
  spans: readonly CategorySpan[],
  mergeGapSeconds: number
): EpisodeSpan[] {
  const episodes: EpisodeSpan[] = [];
  for (const span of spans) {
    const previous = episodes.at(-1);
    if (
      previous !== undefined &&
      span.startSeconds - previous.endSeconds <= mergeGapSeconds
    ) {
      previous.endSeconds = Math.max(previous.endSeconds, span.endSeconds);
      previous.samples.push(...span.samples);
      continue;
    }
    episodes.push({
      startSeconds: span.startSeconds,
      endSeconds: span.endSeconds,
      samples: [...span.samples],
    });
  }
  return episodes;
}

export function condenseNudityFindings(
  findings: readonly TimestampedNudityFinding[],
  config: NudityCondensationConfig
): ContentAnalysisEventDraft[] {
  const selected = new Set(config.selectedCategories);
  const selectedFindings = findings
    .filter((finding) => selected.has(finding.category))
    .sort(
      (left, right) =>
        left.timestampSeconds - right.timestampSeconds ||
        left.category.localeCompare(right.category) ||
        right.score - left.score ||
        (left.providerLabel ?? "").localeCompare(right.providerLabel ?? "")
    )
    .filter(
      (finding, index, sorted) =>
        index === 0 ||
        finding.timestampSeconds !== sorted[index - 1].timestampSeconds ||
        finding.category !== sorted[index - 1].category
    );
  const spans = [...selected]
    .sort()
    .flatMap((category) =>
      buildCategorySpans(
        category,
        selectedFindings.filter((finding) => finding.category === category),
        config.thresholds[category] ?? config.defaultThreshold,
        config
      )
    )
    .sort(
      (left, right) =>
        left.startSeconds - right.startSeconds ||
        left.endSeconds - right.endSeconds ||
        left.category.localeCompare(right.category)
    );

  return mergeSpans(spans, config.mergeGapSeconds).map((span) => {
    span.samples.sort(compareSamples);
    const peak = span.samples[0];
    const summaries = [
      ...new Set(span.samples.map((sample) => sample.category)),
    ]
      .sort()
      .map((category) => {
        const categorySamples = span.samples.filter(
          (sample) => sample.category === category
        );
        const categoryPeak = [...categorySamples].sort(compareSamples)[0];
        const sum = categorySamples.reduce(
          (total, sample) => total + sample.score,
          0
        );
        return {
          category,
          count: categorySamples.length,
          maxScore: categoryPeak.score,
          meanScore: sum / categorySamples.length,
          ...(categoryPeak.providerLabel === undefined
            ? {}
            : { providerLabel: categoryPeak.providerLabel }),
        };
      });
    const boundedSpan = {
      ...span,
      startSeconds: Math.max(0, span.startSeconds - config.preRollSeconds),
      endSeconds: Math.min(
        config.videoDurationSeconds,
        span.endSeconds + config.postRollSeconds
      ),
    };
    return {
      generationKey: eventGenerationKey(
        config.generationKeyPrefix,
        boundedSpan
      ),
      startSeconds: boundedSpan.startSeconds,
      peakSeconds: peak.timestampSeconds,
      endSeconds: boundedSpan.endSeconds,
      categorySummary: summaries,
    };
  });
}
