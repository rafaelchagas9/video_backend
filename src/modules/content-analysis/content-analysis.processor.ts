import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { SystemBookmarkCategoryKey } from "@/modules/bookmarks/bookmark-categories.constants";
import {
  condenseNudityFindings,
  type NudityCategoryThreshold,
  type TimestampedNudityFinding,
} from "./content-analysis.condensation";
import type {
  ContentAnalysisSourceCandidate,
  ContentAnalysisSourceSnapshotResolver,
  ResolvedContentAnalysisSource,
} from "./content-analysis.source-resolver";
import type {
  ContentAnalysisChunkExtractor,
  ExtractedContentAnalysisChunk,
} from "./content-analysis.pts-extractor";
import type {
  ContentAnalysisObservation,
  ContentAnalysisObservationChunk,
  ContentAnalysisProcessor,
  ContentAnalysisProcessorContext,
  ContentAnalysisProfile,
  ContentAnalysisRun,
} from "./content-analysis.types";
import {
  ContentAnalysisAnalyzerChangedError,
  ContentAnalysisSourceChangedError,
  RetryableContentAnalysisError,
} from "./content-analysis.store";
import { sourceMatchesRun } from "./content-analysis.source";
import { VisionInferenceHttpError } from "./visual-inference.http.adapter";
import type {
  VisualInferencePort,
  VisionBatchItem,
  VisionCapability,
} from "./visual-inference.types";

const RETRYABLE_ITEM_ERROR_CODES = new Set([
  "CAPABILITY_NOT_READY",
  "DETECTOR_INITIALIZATION_FAILED",
  "INFERENCE_FAILED",
  "OVERLOADED",
]);
const SKIPPABLE_ITEM_ERROR_CODES = new Set([
  "EMPTY_IMAGE",
  "IMAGE_TOO_LARGE",
  "INVALID_IMAGE",
  "IMAGE_PREPROCESSING_FAILED",
]);
const MULTIPART_OVERHEAD_RESERVE_BYTES = 64 * 1024;

interface BufferedAnalysisFrame {
  index: number;
  ptsSeconds: number;
  image: Blob;
}

export interface NudityProcessorProfileConfig {
  coarseIntervalSeconds: number;
  refinementIntervalSeconds: number | null;
  keyframesOnly?: boolean;
  chunkDurationSeconds?: number;
  condensation?: Partial<
    Pick<
      NudityContentAnalysisProcessorConfig,
      | "confirmationCount"
      | "confirmationWindowSeconds"
      | "negativeToleranceSeconds"
      | "mergeGapSeconds"
      | "preRollSeconds"
      | "postRollSeconds"
    >
  >;
}

export interface NudityContentAnalysisProcessorConfig {
  revision: string;
  analyzerRevision: string;
  requiredProvider: string;
  chunkDurationSeconds: number;
  refinementChunkDurationSeconds: number;
  maxRefinementWindows: number;
  maxBatchItems: number;
  maxFrameDimension: number;
  refinementWindowSeconds: number;
  refinementScoreFloor: number;
  profiles: Readonly<
    Record<ContentAnalysisProfile, NudityProcessorProfileConfig>
  >;
  thresholds: Readonly<
    Partial<Record<SystemBookmarkCategoryKey, NudityCategoryThreshold>>
  >;
  defaultThreshold: NudityCategoryThreshold;
  confirmationCount: number;
  confirmationWindowSeconds: number;
  negativeToleranceSeconds: number;
  mergeGapSeconds: number;
  preRollSeconds: number;
  postRollSeconds: number;
}

export const DEFAULT_NUDITY_PROCESSOR_CONFIG: NudityContentAnalysisProcessorConfig =
  {
    revision: "nudity-processor-v4",
    analyzerRevision: "nudity-processor-v4",
    requiredProvider: "MIGraphXExecutionProvider",
    chunkDurationSeconds: 60,
    refinementChunkDurationSeconds: 30,
    maxRefinementWindows: 1_000,
    maxBatchItems: 16,
    maxFrameDimension: 640,
    refinementWindowSeconds: 4,
    refinementScoreFloor: 0.35,
    profiles: {
      fast: {
        coarseIntervalSeconds: 4,
        refinementIntervalSeconds: null,
        keyframesOnly: true,
        chunkDurationSeconds: 1_800,
        condensation: {
          confirmationWindowSeconds: 10,
          negativeToleranceSeconds: 10,
          mergeGapSeconds: 10,
          preRollSeconds: 5,
          postRollSeconds: 5,
        },
      },
      balanced: {
        coarseIntervalSeconds: 2,
        refinementIntervalSeconds: 1,
        chunkDurationSeconds: 180,
      },
      thorough: { coarseIntervalSeconds: 1, refinementIntervalSeconds: 0.5 },
    },
    thresholds: {},
    defaultThreshold: { entryScore: 0.65, exitScore: 0.45 },
    confirmationCount: 2,
    confirmationWindowSeconds: 3,
    negativeToleranceSeconds: 2,
    mergeGapSeconds: 3,
    preRollSeconds: 2,
    postRollSeconds: 2,
  };

export interface NudityContentAnalysisProcessorDependencies {
  sourceResolver: ContentAnalysisSourceSnapshotResolver;
  loadSourceCandidate(
    videoId: number
  ): Promise<ContentAnalysisSourceCandidate | null>;
  extractor: ContentAnalysisChunkExtractor;
  inference: VisualInferencePort;
  readFrame?(path: string): Promise<Blob>;
  config?: NudityContentAnalysisProcessorConfig;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason;
}

function mergeRefinementWindows(
  findings: readonly ContentAnalysisObservation[],
  durationSeconds: number,
  radiusSeconds: number,
  scoreFloor: number,
  maxWindows: number
): Array<{ startSeconds: number; endSeconds: number }> {
  const candidates = findings
    .filter((finding) => finding.score >= scoreFloor)
    .map((finding) => ({
      startSeconds: Math.max(0, finding.timestampSeconds - radiusSeconds),
      endSeconds: Math.min(
        durationSeconds,
        finding.timestampSeconds + radiusSeconds
      ),
    }))
    .sort((left, right) => left.startSeconds - right.startSeconds);
  const merged: Array<{ startSeconds: number; endSeconds: number }> = [];
  for (const candidate of candidates) {
    const previous = merged.at(-1);
    if (previous && candidate.startSeconds <= previous.endSeconds) {
      previous.endSeconds = Math.max(previous.endSeconds, candidate.endSeconds);
    } else if (candidate.endSeconds > candidate.startSeconds) {
      merged.push(candidate);
    }
  }
  if (merged.length <= maxWindows) return merged;
  const groupSize = Math.ceil(merged.length / maxWindows);
  const coalesced: Array<{ startSeconds: number; endSeconds: number }> = [];
  for (let index = 0; index < merged.length; index += groupSize) {
    const group = merged.slice(index, index + groupSize);
    coalesced.push({
      startSeconds: group[0]!.startSeconds,
      endSeconds: group.at(-1)!.endSeconds,
    });
  }
  return coalesced;
}

function summarizeChunks(chunks: readonly ContentAnalysisObservationChunk[]): {
  sampledFrames: number;
  positiveFrames: number;
} {
  return chunks.reduce(
    (summary, chunk) => ({
      sampledFrames: summary.sampledFrames + chunk.sampledFrames,
      positiveFrames: summary.positiveFrames + chunk.positiveFrames,
    }),
    { sampledFrames: 0, positiveFrames: 0 }
  );
}

export class NudityContentAnalysisProcessor {
  readonly process: ContentAnalysisProcessor;
  private readonly config: NudityContentAnalysisProcessorConfig;
  private readonly readFrame: (path: string) => Promise<Blob>;

  constructor(
    private readonly dependencies: NudityContentAnalysisProcessorDependencies
  ) {
    this.config = dependencies.config ?? DEFAULT_NUDITY_PROCESSOR_CONFIG;
    this.readFrame =
      dependencies.readFrame ??
      (async (path) => {
        const extension = extname(path).toLowerCase();
        const type =
          extension === ".jpg" || extension === ".jpeg"
            ? "image/jpeg"
            : extension === ".webp"
              ? "image/webp"
              : "image/png";
        return new Blob([await readFile(path)], { type });
      });
    this.process = (run, context) => this.run(run, context);
  }

  private async run(
    run: ContentAnalysisRun,
    context: ContentAnalysisProcessorContext
  ): Promise<{ events: ReturnType<typeof condenseNudityFindings> }> {
    try {
      const source = await this.resolveSource(run, context.signal);
      const capability = await this.loadCapability(run, context.signal);
      const profile = this.config.profiles[run.profile];
      const usesRefinement = profile.refinementIntervalSeconds !== null;
      let staged = await context.loadObservationChunks();
      const resumePhase = context.resumeCheckpoint?.phase ?? "extracting";
      const skipCoarse = ["refining", "condensing", "publishing"].includes(
        resumePhase
      );

      if (!skipCoarse) {
        const coarseChunks = staged.filter((chunk) => chunk.phase === "coarse");
        const coarseStart =
          Math.max(-1, ...coarseChunks.map((chunk) => chunk.chunkIndex)) + 1;
        await this.extractPass({
          run,
          source,
          context,
          capability,
          phase: "coarse",
          progressPhase: "analyzing",
          sampleIntervalSeconds: profile.coarseIntervalSeconds,
          startChunkIndex: coarseStart,
          keyframesOnly: profile.keyframesOnly ?? false,
          chunkDurationSeconds: profile.chunkDurationSeconds,
        });
        staged = await context.loadObservationChunks();
      }

      const coarseFindings = staged
        .filter((chunk) => chunk.phase === "coarse")
        .flatMap((chunk) => chunk.findings);
      const refinementWindows = usesRefinement
        ? mergeRefinementWindows(
            coarseFindings,
            run.sourceDurationSeconds,
            this.config.refinementWindowSeconds,
            this.config.refinementScoreFloor,
            this.config.maxRefinementWindows
          )
        : [];
      if (
        usesRefinement &&
        resumePhase !== "condensing" &&
        resumePhase !== "publishing"
      ) {
        const refinedChunks = staged.filter(
          (chunk) => chunk.phase === "refining"
        );
        const refinementStart =
          Math.max(-1, ...refinedChunks.map((chunk) => chunk.chunkIndex)) + 1;
        if (refinementWindows.length > 0) {
          await this.extractPass({
            run,
            source,
            context,
            capability,
            phase: "refining",
            progressPhase: "refining",
            windows: refinementWindows,
            sampleIntervalSeconds: profile.refinementIntervalSeconds!,
            startChunkIndex: refinementStart,
          });
        }
        staged = await context.loadObservationChunks();
        const totals = summarizeChunks(staged);
        await context.checkpoint({
          phase: "condensing",
          scannedSeconds: run.sourceDurationSeconds,
          ...totals,
        });
      } else if (
        !usesRefinement &&
        resumePhase !== "condensing" &&
        resumePhase !== "publishing"
      ) {
        const totals = summarizeChunks(staged);
        await context.checkpoint({
          phase: "condensing",
          scannedSeconds: run.sourceDurationSeconds,
          ...totals,
        });
      }

      const findings = (await context.loadObservationChunks())
        .filter((chunk) =>
          usesRefinement ? chunk.phase === "refining" : chunk.phase === "coarse"
        )
        .flatMap((chunk) => chunk.findings) as TimestampedNudityFinding[];
      const condensation = profile.condensation ?? {};
      return {
        events: condenseNudityFindings(findings, {
          generationKeyPrefix: run.semanticGenerationKey,
          videoDurationSeconds: run.sourceDurationSeconds,
          selectedCategories: run.requestedCategories,
          thresholds: this.config.thresholds,
          defaultThreshold: this.config.defaultThreshold,
          confirmationCount:
            condensation.confirmationCount ?? this.config.confirmationCount,
          confirmationWindowSeconds:
            condensation.confirmationWindowSeconds ??
            this.config.confirmationWindowSeconds,
          negativeToleranceSeconds:
            condensation.negativeToleranceSeconds ??
            this.config.negativeToleranceSeconds,
          mergeGapSeconds:
            condensation.mergeGapSeconds ?? this.config.mergeGapSeconds,
          preRollSeconds:
            condensation.preRollSeconds ?? this.config.preRollSeconds,
          postRollSeconds:
            condensation.postRollSeconds ?? this.config.postRollSeconds,
        }),
      };
    } catch (error) {
      if (error instanceof VisionInferenceHttpError && error.retryable) {
        throw new RetryableContentAnalysisError(
          error.code,
          "Vision service is temporarily unavailable"
        );
      }
      throw error;
    }
  }

  private async resolveSource(
    run: ContentAnalysisRun,
    signal: AbortSignal
  ): Promise<ResolvedContentAnalysisSource> {
    const candidate = await this.dependencies.loadSourceCandidate(run.videoId);
    if (!candidate) throw new Error("Video source is unavailable");
    const source = await this.dependencies.sourceResolver.resolve(
      candidate,
      signal
    );
    if (!sourceMatchesRun(source, run)) {
      throw new ContentAnalysisSourceChangedError();
    }
    return source;
  }

  private async loadCapability(
    run: ContentAnalysisRun,
    signal: AbortSignal
  ): Promise<VisionCapability> {
    const capabilities = await this.dependencies.inference.capabilities(signal);
    const capability = capabilities.capabilities.find(
      (candidate) => candidate.name === "nudity"
    );
    if (!capability?.ready) {
      throw new RetryableContentAnalysisError(
        "CAPABILITY_NOT_READY",
        "Nudity analysis capability is not ready"
      );
    }
    if (
      run.analyzerRevision !== this.config.analyzerRevision ||
      run.configRevision !== this.config.revision ||
      capability.modelRevision !== run.modelRevision ||
      capability.taxonomyRevision !== run.taxonomyRevision ||
      !capability.providers.includes(this.config.requiredProvider)
    ) {
      throw new ContentAnalysisAnalyzerChangedError();
    }
    return capability;
  }

  private async extractPass(input: {
    run: ContentAnalysisRun;
    source: ResolvedContentAnalysisSource;
    context: ContentAnalysisProcessorContext;
    capability: VisionCapability;
    phase: ContentAnalysisObservationChunk["phase"];
    progressPhase: "analyzing" | "refining";
    windows?: readonly { startSeconds: number; endSeconds: number }[];
    sampleIntervalSeconds: number;
    startChunkIndex: number;
    keyframesOnly?: boolean;
    chunkDurationSeconds?: number;
  }): Promise<void> {
    const iterable = this.dependencies.extractor.extract(
      {
        filePath: input.source.filePath,
        durationSeconds: input.run.sourceDurationSeconds,
        ...(input.windows ? { windows: input.windows } : {}),
        startChunkIndex: input.startChunkIndex,
        chunkDurationSeconds:
          input.chunkDurationSeconds ??
          (input.phase === "refining"
            ? this.config.refinementChunkDurationSeconds
            : this.config.chunkDurationSeconds),
        sampleIntervalSeconds: input.sampleIntervalSeconds,
        maxFrameDimension: this.config.maxFrameDimension,
        keyframesOnly: input.keyframesOnly ?? false,
      },
      input.context.signal
    );
    const iterator = iterable[Symbol.asyncIterator]();
    try {
      let pending = iterator.next();
      for (;;) {
        const step = await pending;
        if (step.done) break;
        const chunk = step.value;
        let frames: BufferedAnalysisFrame[];
        try {
          frames = await Promise.all(
            chunk.frames.map(async (frame) => ({
              index: frame.index,
              ptsSeconds: frame.ptsSeconds,
              image: await this.readFrame(frame.path),
            }))
          );
        } finally {
          await chunk.dispose();
        }
        // The frames are buffered, so extraction of the next chunk can
        // overlap this chunk's inference. The early rejection handler only
        // marks the promise as observed; the loop still awaits it.
        pending = iterator.next();
        pending.catch(() => {});
        const stagedBeforeAnalysis =
          await input.context.loadObservationChunks();
        const totalsBeforeAnalysis = summarizeChunks(stagedBeforeAnalysis);
        await input.context.checkpoint({
          phase: input.progressPhase,
          scannedSeconds:
            input.phase === "coarse"
              ? Math.min(input.run.sourceDurationSeconds, chunk.startSeconds)
              : input.run.sourceDurationSeconds,
          ...totalsBeforeAnalysis,
          cursor: { chunkIndex: chunk.chunkIndex },
        });
        const observationChunk = await this.analyzeChunk(
          input.run,
          input.phase,
          chunk,
          frames,
          input.capability,
          input.context.signal
        );
        await input.context.stageObservationChunk(observationChunk);
        const staged = await input.context.loadObservationChunks();
        const totals = summarizeChunks(staged);
        await input.context.checkpoint({
          phase: input.progressPhase,
          scannedSeconds:
            input.phase === "coarse"
              ? Math.min(input.run.sourceDurationSeconds, chunk.endSeconds)
              : input.run.sourceDurationSeconds,
          ...totals,
          cursor: { chunkIndex: chunk.chunkIndex + 1 },
        });
      }
    } finally {
      await iterator.return?.();
    }
  }

  private async analyzeChunk(
    run: ContentAnalysisRun,
    phase: ContentAnalysisObservationChunk["phase"],
    chunk: Pick<
      ExtractedContentAnalysisChunk,
      "chunkIndex" | "startSeconds" | "endSeconds"
    >,
    frames: readonly BufferedAnalysisFrame[],
    capability: VisionCapability,
    signal: AbortSignal
  ): Promise<ContentAnalysisObservationChunk> {
    const findings: ContentAnalysisObservation[] = [];
    let positiveFrames = 0;
    const itemLimit = Math.min(
      this.config.maxBatchItems,
      capability.maxBatchItems
    );
    const byteLimit = Math.max(
      1,
      capability.maxBatchBytes - MULTIPART_OVERHEAD_RESERVE_BYTES
    );
    let batch: VisionBatchItem[] = [];
    let batchBytes = 0;
    let successfulFrames = 0;
    let skippedFrames = 0;

    const flush = async (): Promise<void> => {
      if (batch.length === 0) return;
      throwIfAborted(signal);
      const result = await this.dependencies.inference.analyzeBatch(
        { capabilities: ["nudity"], items: batch },
        signal
      );
      for (const item of result.items) {
        const outcome = item.outcomes[0]!;
        if (outcome.status === "error") {
          if (RETRYABLE_ITEM_ERROR_CODES.has(outcome.error.code)) {
            throw new RetryableContentAnalysisError(
              outcome.error.code,
              "Vision service could not analyze a frame"
            );
          }
          if (SKIPPABLE_ITEM_ERROR_CODES.has(outcome.error.code)) {
            skippedFrames += 1;
            continue;
          }
          throw new Error("Vision service rejected an extracted frame");
        }
        successfulFrames += 1;
        const selected = outcome.findings.filter(
          (finding) =>
            finding.capability === "nudity" &&
            run.requestedCategories.includes(
              finding.label as SystemBookmarkCategoryKey
            )
        );
        if (selected.length > 0) positiveFrames += 1;
        for (const finding of selected) {
          const providerLabel = finding.metadata?.provider_label;
          findings.push({
            timestampSeconds: item.timestampSeconds,
            category: finding.label as SystemBookmarkCategoryKey,
            score: finding.score,
            providerLabel:
              typeof providerLabel === "string" ? providerLabel : finding.label,
          });
        }
      }
      batch = [];
      batchBytes = 0;
    };

    for (const frame of frames) {
      throwIfAborted(signal);
      const image = frame.image;
      if (
        image.size === 0 ||
        image.size > capability.maxImageBytes ||
        image.size > byteLimit
      ) {
        throw new Error("Extracted frame exceeds vision service limits");
      }
      if (
        batch.length >= itemLimit ||
        (batch.length > 0 && batchBytes + image.size > byteLimit)
      ) {
        await flush();
      }
      batch.push({
        id: `${run.id}:${phase}:${chunk.chunkIndex}:${frame.index}`,
        timestampSeconds: frame.ptsSeconds,
        image,
      });
      batchBytes += image.size;
    }
    await flush();
    const allowedSkippedFrames = Math.max(
      1,
      Math.floor(frames.length * 0.01)
    );
    if (
      (frames.length > 0 && successfulFrames === 0) ||
      skippedFrames > allowedSkippedFrames
    ) {
      throw new Error("Vision service rejected too many extracted frames");
    }
    return {
      phase,
      chunkIndex: chunk.chunkIndex,
      startSeconds: chunk.startSeconds,
      endSeconds: chunk.endSeconds,
      sampledFrames: frames.length,
      positiveFrames,
      findings,
    };
  }
}
