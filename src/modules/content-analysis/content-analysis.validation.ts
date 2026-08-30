import type {
  ContentAnalysisEventDraft,
  ContentAnalysisObservationChunk,
  ContentAnalysisProgress,
  ContentAnalysisRun,
} from "./content-analysis.types";

export const CONTENT_ANALYSIS_ACTIVE_PHASE_ORDER = [
  "extracting",
  "analyzing",
  "refining",
  "condensing",
  "publishing",
] as const;

const MAX_EVENT_DRAFTS = 10_000;
const MAX_EVENT_DRAFT_BYTES = 2 * 1024 * 1024;
const MAX_GENERATION_KEY_LENGTH = 255;
const MAX_PROVIDER_LABEL_LENGTH = 255;
const MAX_OBSERVATION_FINDINGS_PER_CHUNK = 20_000;
const MAX_OBSERVATION_BYTES_PER_CHUNK = 2 * 1024 * 1024;
const contentAnalysisObservationChunkSchema = z
  .object({
    phase: z.enum(["coarse", "refining"]),
    chunkIndex: z.number().int().nonnegative(),
    startSeconds: z.number().finite().nonnegative(),
    endSeconds: z.number().finite().nonnegative(),
    sampledFrames: z.number().int().nonnegative(),
    positiveFrames: z.number().int().nonnegative(),
    findings: z.array(
      z
        .object({
          timestampSeconds: z.number().finite().nonnegative(),
          category: z.enum(SYSTEM_BOOKMARK_CATEGORY_KEYS),
          score: z.number().finite().min(0).max(1),
          providerLabel: z.string().min(1).max(255).optional(),
        })
        .strict()
    ),
  })
  .strict();

export function assertContentAnalysisProgress(
  progress: ContentAnalysisProgress,
  duration: number,
  previous?: ContentAnalysisProgress
): void {
  const phaseIndex = CONTENT_ANALYSIS_ACTIVE_PHASE_ORDER.indexOf(
    progress.phase
  );
  const previousPhaseIndex = previous
    ? CONTENT_ANALYSIS_ACTIVE_PHASE_ORDER.indexOf(previous.phase)
    : -1;
  const cursorRegressed =
    previous?.phase === progress.phase &&
    previous?.cursor !== undefined &&
    (progress.cursor === undefined ||
      progress.cursor.chunkIndex < previous.cursor.chunkIndex ||
      (progress.cursor.chunkIndex === previous.cursor.chunkIndex &&
        (progress.cursor.itemOffset ?? 0) < (previous.cursor.itemOffset ?? 0)));

  if (
    !Number.isFinite(duration) ||
    duration <= 0 ||
    phaseIndex < previousPhaseIndex ||
    !Number.isFinite(progress.scannedSeconds) ||
    progress.scannedSeconds < 0 ||
    progress.scannedSeconds > duration ||
    (previous !== undefined &&
      progress.scannedSeconds < previous.scannedSeconds) ||
    !Number.isInteger(progress.sampledFrames) ||
    progress.sampledFrames < 0 ||
    (previous !== undefined &&
      progress.sampledFrames < previous.sampledFrames) ||
    !Number.isInteger(progress.positiveFrames) ||
    progress.positiveFrames < 0 ||
    (previous !== undefined &&
      progress.positiveFrames < previous.positiveFrames) ||
    progress.positiveFrames > progress.sampledFrames ||
    cursorRegressed
  ) {
    throw new Error("Invalid content analysis checkpoint");
  }
}

export function assertContentAnalysisEvents(
  events: ContentAnalysisEventDraft[],
  run: ContentAnalysisRun
): void {
  if (
    events.length > MAX_EVENT_DRAFTS ||
    new TextEncoder().encode(JSON.stringify(events)).byteLength >
      MAX_EVENT_DRAFT_BYTES
  ) {
    throw new Error("Content analysis event draft limit exceeded");
  }

  const generationKeys = new Set<string>();
  for (const event of events) {
    if (
      !event.generationKey ||
      event.generationKey.length > MAX_GENERATION_KEY_LENGTH ||
      generationKeys.has(event.generationKey) ||
      ![event.startSeconds, event.peakSeconds, event.endSeconds].every(
        Number.isFinite
      ) ||
      event.startSeconds < 0 ||
      event.startSeconds > event.peakSeconds ||
      event.peakSeconds > event.endSeconds ||
      event.endSeconds > run.sourceDurationSeconds ||
      event.categorySummary.length === 0
    ) {
      throw new Error("Invalid content analysis event draft");
    }
    generationKeys.add(event.generationKey);

    const summaryCategories = new Set<string>();
    for (const summary of event.categorySummary) {
      if (
        !run.requestedCategories.includes(summary.category) ||
        summaryCategories.has(summary.category) ||
        !Number.isInteger(summary.count) ||
        summary.count <= 0 ||
        !Number.isFinite(summary.maxScore) ||
        summary.maxScore < 0 ||
        summary.maxScore > 1 ||
        !Number.isFinite(summary.meanScore) ||
        summary.meanScore < 0 ||
        summary.meanScore > summary.maxScore ||
        (summary.providerLabel !== undefined &&
          (summary.providerLabel.length === 0 ||
            summary.providerLabel.length > MAX_PROVIDER_LABEL_LENGTH))
      ) {
        throw new Error("Invalid content analysis category summary");
      }
      summaryCategories.add(summary.category);
    }
  }
}

export function assertContentAnalysisObservationChunk(
  chunk: ContentAnalysisObservationChunk,
  run: ContentAnalysisRun
): void {
  if (!contentAnalysisObservationChunkSchema.safeParse(chunk).success) {
    throw new Error("Invalid content analysis observation chunk");
  }
  if (
    chunk.startSeconds > chunk.endSeconds ||
    chunk.endSeconds > run.sourceDurationSeconds ||
    chunk.positiveFrames > chunk.sampledFrames ||
    chunk.findings.length > MAX_OBSERVATION_FINDINGS_PER_CHUNK ||
    new TextEncoder().encode(JSON.stringify(chunk.findings)).byteLength >
      MAX_OBSERVATION_BYTES_PER_CHUNK
  ) {
    throw new Error("Invalid content analysis observation chunk");
  }

  for (const finding of chunk.findings) {
    if (
      !run.requestedCategories.includes(finding.category) ||
      finding.timestampSeconds < chunk.startSeconds ||
      finding.timestampSeconds > chunk.endSeconds
    ) {
      throw new Error("Invalid content analysis observation finding");
    }
  }
}
import { z } from "zod";
import { SYSTEM_BOOKMARK_CATEGORY_KEYS } from "@/modules/bookmarks/bookmark-categories.constants";
