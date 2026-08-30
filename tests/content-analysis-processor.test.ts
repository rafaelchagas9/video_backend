import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ContentAnalysisHandler,
  ContentAnalysisService,
  DEFAULT_NUDITY_PROCESSOR_CONFIG,
  InMemoryContentAnalysisRunStore,
  NudityContentAnalysisProcessor,
  RetryableContentAnalysisError,
  type ContentAnalysisChunkExtractor,
  type ContentAnalysisObservationChunk,
  type ContentAnalysisProcessorContext,
  type ContentAnalysisResumeCheckpoint,
  type ContentAnalysisRun,
  type ExtractedContentAnalysisChunk,
  type PtsAwareExtractionInput,
  type VisualInferencePort,
  type VisionBatch,
  type VisionBatchResult,
  type VisionCapability,
} from "@/modules/content-analysis";
import {
  DurableJobsService,
  DurableJobWorker,
  InMemoryDurableJobStore,
} from "@/modules/durable-jobs";

const run: ContentAnalysisRun = {
  id: 9,
  durableJobId: 19,
  videoId: 42,
  userId: 7,
  kind: "nudity",
  profile: "balanced",
  requestedCategories: ["BUTTOCKS_EXPOSED"],
  status: "running",
  phase: "extracting",
  scannedSeconds: 0,
  sourceDurationSeconds: 12,
  sampledFrames: 0,
  positiveFrames: 0,
  sourceFingerprint: "partial-sha256-v1:fixture",
  analyzerRevision: "nudity-processor-v4",
  modelRevision: "nudenet-640m",
  taxonomyRevision: "nudenet-selected-11-v1",
  configRevision: "nudity-processor-v4",
  idempotencyKey: null,
  requestDigest: "request:fixture",
  semanticGenerationKey: "semantic:fixture",
  resultEventCount: 0,
  resultBookmarkCount: 0,
  errorCode: null,
  errorMessage: null,
  retryCount: 0,
  isPublished: false,
  publishedAt: null,
  startedAt: new Date("2026-08-28T12:00:00Z"),
  completedAt: null,
  cancelledAt: null,
  createdAt: new Date("2026-08-28T12:00:00Z"),
  updatedAt: new Date("2026-08-28T12:00:00Z"),
};

function frame(index: number, ptsSeconds: number) {
  return { index, ptsSeconds, path: `/synthetic/frame-${index}.png` };
}

function chunk(
  chunkIndex: number,
  startSeconds: number,
  endSeconds: number,
  pts: number[],
  disposed: number[]
): ExtractedContentAnalysisChunk {
  return {
    chunkIndex,
    startSeconds,
    endSeconds,
    frames: pts.map((timestamp, index) => frame(index, timestamp)),
    async dispose() {
      disposed.push(chunkIndex);
    },
  };
}

class RecordingExtractor implements ContentAnalysisChunkExtractor {
  readonly requests: PtsAwareExtractionInput[] = [];
  readonly disposed: number[] = [];

  constructor(
    private readonly coarse: ExtractedContentAnalysisChunk[],
    private readonly refining: ExtractedContentAnalysisChunk[]
  ) {}

  async *extract(
    input: PtsAwareExtractionInput
  ): AsyncIterable<ExtractedContentAnalysisChunk> {
    this.requests.push(structuredClone(input));
    const available = input.windows ? this.refining : this.coarse;
    for (const value of available) {
      if (value.chunkIndex >= (input.startChunkIndex ?? 0)) yield value;
    }
  }
}

class FindingInference implements VisualInferencePort {
  readonly requests: VisionBatch[] = [];

  constructor(
    private readonly scoreForItem: (
      id: string,
      timestamp: number
    ) => number | { error: string } | null,
    private readonly maxBatchBytes = 128 * 1024,
    private readonly capabilityOverrides: Partial<VisionCapability> = {}
  ) {}

  async capabilities() {
    return {
      version: "1" as const,
      capabilities: [
        {
          name: "nudity",
          ready: true,
          state: "ready",
          providers: ["MIGraphXExecutionProvider"],
          modelRevision: "nudenet-640m",
          taxonomyRevision: "nudenet-selected-11-v1",
          maxBatchItems: 2,
          maxBatchBytes: this.maxBatchBytes,
          maxImageBytes: 64 * 1024,
          maxImagePixels: 640 * 640,
          ...this.capabilityOverrides,
        },
      ],
    };
  }

  async analyzeBatch(input: VisionBatch): Promise<VisionBatchResult> {
    this.requests.push(input);
    return {
      version: "1",
      items: input.items.map((item) => {
        const configured = this.scoreForItem(item.id, item.timestampSeconds);
        return {
          id: item.id,
          timestampSeconds: item.timestampSeconds,
          width: 64,
          height: 64,
          outcomes: [
            typeof configured === "object" && configured !== null
              ? {
                  capability: "nudity",
                  status: "error" as const,
                  error: {
                    code: configured.error,
                    message: "synthetic item failure",
                  },
                }
              : {
                  capability: "nudity",
                  status: "ok" as const,
                  findings:
                    configured === null
                      ? []
                      : [
                          {
                            capability: "nudity",
                            label: "BUTTOCKS_EXPOSED",
                            score: configured,
                            box: {
                              space: "normalized" as const,
                              x1: 0.1,
                              y1: 0.1,
                              x2: 0.2,
                              y2: 0.2,
                            },
                            metadata: {
                              provider_label: "BUTTOCKS_EXPOSED",
                            },
                          },
                        ],
                },
          ],
        };
      }),
    };
  }
}

function context(
  initial: ContentAnalysisObservationChunk[] = [],
  resumeCheckpoint: ContentAnalysisResumeCheckpoint | null = null
) {
  const staged = new Map(
    initial.map((value) => [`${value.phase}:${value.chunkIndex}`, value])
  );
  const checkpoints: Parameters<
    ContentAnalysisProcessorContext["checkpoint"]
  >[0][] = [];
  const value: ContentAnalysisProcessorContext = {
    signal: new AbortController().signal,
    resumeCheckpoint,
    async checkpoint(progress) {
      checkpoints.push(structuredClone(progress));
    },
    async stageObservationChunk(observation) {
      staged.set(
        `${observation.phase}:${observation.chunkIndex}`,
        structuredClone(observation)
      );
    },
    async loadObservationChunks() {
      return [...staged.values()].map((observation) =>
        structuredClone(observation)
      );
    },
  };
  return { value, staged, checkpoints };
}

function processor(
  extractor: ContentAnalysisChunkExtractor,
  inference: VisualInferencePort,
  readFrame: (path: string) => Promise<Blob> = async () =>
    new Blob(["synthetic-frame"], { type: "image/png" }),
  expectedRun: ContentAnalysisRun = run
) {
  return new NudityContentAnalysisProcessor({
    sourceResolver: {
      async resolve(candidate) {
        return {
          ...candidate,
          sourceFingerprint: expectedRun.sourceFingerprint,
          durationSeconds: expectedRun.sourceDurationSeconds,
          sizeBytes: 1_000,
          mtimeMs: 1,
        };
      },
    },
    loadSourceCandidate: async (videoId) => ({
      id: videoId,
      filePath: "/synthetic/video.mkv",
    }),
    extractor,
    inference,
    readFrame,
  });
}

describe("NudityContentAnalysisProcessor", () => {
  it("bounds cold GPU compilation and retry work with small fixed batches and chunks", () => {
    expect(DEFAULT_NUDITY_PROCESSOR_CONFIG).toMatchObject({
      revision: "nudity-processor-v4",
      analyzerRevision: "nudity-processor-v4",
      chunkDurationSeconds: 60,
      refinementChunkDurationSeconds: 30,
      maxBatchItems: 16,
    });
  });

  it("uses sparse keyframes without refinement for the fast profile", async () => {
    const disposed: number[] = [];
    const extractor = new RecordingExtractor(
      [chunk(0, 0, 24, [0, 8, 16], disposed)],
      [chunk(0, 0, 24, [0.5, 1], disposed)]
    );
    const inference = new FindingInference((_id, timestamp) =>
      timestamp === 0 || timestamp === 8 ? 0.6 : null
    );
    const fastRun: ContentAnalysisRun = {
      ...run,
      profile: "fast",
      sourceDurationSeconds: 24,
    };
    const state = context();

    const result = await processor(
      extractor,
      inference,
      undefined,
      fastRun
    ).process(fastRun, state.value);

    expect(extractor.requests).toHaveLength(1);
    expect(extractor.requests[0]).toMatchObject({
      keyframesOnly: true,
      chunkDurationSeconds: 1_800,
      sampleIntervalSeconds: 4,
    });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      startSeconds: 0,
      endSeconds: 13,
    });
    expect(disposed).toEqual([0]);
  });

  it("sends extracted JPEG frames with their truthful media type", async () => {
    const root = await mkdtemp(join(tmpdir(), "content-analysis-jpeg-test-"));
    const framePath = join(root, "frame-000000.jpg");
    await writeFile(framePath, "synthetic-jpeg-bytes");
    const extractor = new RecordingExtractor(
      [
        {
          chunkIndex: 0,
          startSeconds: 0,
          endSeconds: 2,
          frames: [{ index: 0, path: framePath, ptsSeconds: 0 }],
          async dispose() {},
        },
      ],
      []
    );
    const inference = new FindingInference(() => null);
    const subject = new NudityContentAnalysisProcessor({
      sourceResolver: {
        async resolve(candidate) {
          return {
            ...candidate,
            sourceFingerprint: run.sourceFingerprint,
            durationSeconds: run.sourceDurationSeconds,
            sizeBytes: 1_000,
            mtimeMs: 1,
          };
        },
      },
      loadSourceCandidate: async (videoId) => ({
        id: videoId,
        filePath: "/synthetic/video.mkv",
      }),
      extractor,
      inference,
    });

    try {
      await subject.process(run, context().value);
      expect(inference.requests[0]?.items[0]?.image.type).toBe("image/jpeg");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("scans bounded coarse batches, refines near-threshold windows, checkpoints, and condenses", async () => {
    const disposed: number[] = [];
    const extractor = new RecordingExtractor(
      [
        chunk(0, 0, 6, [0, 2, 4], disposed),
        chunk(1, 6, 12, [6, 8, 10], disposed),
      ],
      [chunk(0, 0, 6, [1.5, 2, 2.5], disposed)]
    );
    const inference = new FindingInference((id, timestamp) => {
      if (id.includes(":coarse:") && timestamp === 2) return 0.4;
      if (id.includes(":refining:") && timestamp === 1.5) return 0.7;
      if (id.includes(":refining:") && timestamp === 2) return 0.9;
      if (id.includes(":refining:") && timestamp === 2.5) return 0.7;
      return null;
    });
    const state = context();

    const result = await processor(extractor, inference).process(
      run,
      state.value
    );

    expect(
      inference.requests.every((request) => request.items.length <= 2)
    ).toBe(true);
    expect(extractor.requests).toHaveLength(2);
    expect(extractor.requests[1]).toMatchObject({
      windows: [{ startSeconds: 0, endSeconds: 6 }],
      sampleIntervalSeconds: 1,
      startChunkIndex: 0,
    });
    expect(disposed).toEqual([0, 1, 0]);
    expect(state.checkpoints.map((checkpoint) => checkpoint.phase)).toEqual([
      "analyzing",
      "analyzing",
      "analyzing",
      "analyzing",
      "refining",
      "refining",
      "condensing",
    ]);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      startSeconds: 0,
      peakSeconds: 2,
      endSeconds: 4.5,
      categorySummary: [
        {
          category: "BUTTOCKS_EXPOSED",
          count: 3,
          maxScore: 0.9,
          meanScore: 0.7666666666666666,
        },
      ],
    });
  });

  it("resumes from persisted chunks without re-extracting acknowledged coarse work", async () => {
    const disposed: number[] = [];
    const extractor = new RecordingExtractor(
      [chunk(0, 0, 12, [0, 2], disposed)],
      [chunk(0, 0, 6, [3.5], disposed), chunk(1, 6, 8, [4.5], disposed)]
    );
    const inference = new FindingInference((id) =>
      id.includes(":refining:1:") ? 0.85 : null
    );
    const coarse: ContentAnalysisObservationChunk = {
      phase: "coarse",
      chunkIndex: 0,
      startSeconds: 0,
      endSeconds: 12,
      sampledFrames: 6,
      positiveFrames: 1,
      findings: [
        {
          timestampSeconds: 4,
          category: "BUTTOCKS_EXPOSED",
          score: 0.5,
        },
      ],
    };
    const refined: ContentAnalysisObservationChunk = {
      phase: "refining",
      chunkIndex: 0,
      startSeconds: 0,
      endSeconds: 6,
      sampledFrames: 1,
      positiveFrames: 1,
      findings: [
        {
          timestampSeconds: 3.5,
          category: "BUTTOCKS_EXPOSED",
          score: 0.8,
        },
      ],
    };
    const state = context([coarse, refined], {
      version: 1,
      phase: "refining",
      scannedSeconds: 12,
      sampledFrames: 7,
      positiveFrames: 2,
      cursor: { chunkIndex: 1 },
    });

    const result = await processor(extractor, inference).process(
      run,
      state.value
    );

    expect(extractor.requests).toHaveLength(1);
    expect(extractor.requests[0]).toMatchObject({
      startChunkIndex: 1,
      windows: [{ startSeconds: 0, endSeconds: 8 }],
    });
    expect(disposed).toEqual([1]);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.peakSeconds).toBe(4.5);
  });

  it("turns retryable per-frame failures into a retry without staging partial chunks", async () => {
    const disposed: number[] = [];
    const extractor = new RecordingExtractor(
      [chunk(0, 0, 6, [0, 2], disposed)],
      []
    );
    const inference = new FindingInference(() => ({ error: "OVERLOADED" }));
    const state = context();

    await expect(
      processor(extractor, inference).process(run, state.value)
    ).rejects.toBeInstanceOf(RetryableContentAnalysisError);
    expect(state.staged.size).toBe(0);
    expect(state.checkpoints).toEqual([
      {
        phase: "analyzing",
        scannedSeconds: 0,
        sampledFrames: 0,
        positiveFrames: 0,
        cursor: { chunkIndex: 0 },
      },
    ]);
    expect(disposed).toEqual([0]);
  });

  it("requires dense refinement to confirm a coarse positive", async () => {
    const disposed: number[] = [];
    const extractor = new RecordingExtractor(
      [chunk(0, 0, 12, [2], disposed)],
      [chunk(0, 0, 6, [1.5, 2, 2.5], disposed)]
    );
    const inference = new FindingInference((id) =>
      id.includes(":coarse:") ? 0.99 : null
    );

    const result = await processor(extractor, inference).process(
      run,
      context().value
    );

    expect(result.events).toEqual([]);
  });

  it("skips one deterministic bad frame but fails when every frame is invalid", async () => {
    const disposed: number[] = [];
    const extractor = new RecordingExtractor(
      [chunk(0, 0, 6, [0, 2, 4], disposed)],
      []
    );
    const partial = new FindingInference((_id, timestamp) =>
      timestamp === 0 ? { error: "INVALID_IMAGE" } : null
    );
    const partialState = context();

    await expect(
      processor(extractor, partial).process(run, partialState.value)
    ).resolves.toEqual({ events: [] });
    expect([...partialState.staged.values()][0]).toMatchObject({
      sampledFrames: 3,
      positiveFrames: 0,
    });

    const allInvalid = new FindingInference(() => ({ error: "INVALID_IMAGE" }));
    await expect(
      processor(extractor, allInvalid).process(run, context().value)
    ).rejects.toThrow("rejected too many extracted frames");
  });

  it("binds the processor to the persisted model, taxonomy, config, and GPU provider", async () => {
    const extractor = new RecordingExtractor([], []);
    const wrongModel = new FindingInference(() => null, 128 * 1024, {
      modelRevision: "nudenet-other",
    });
    await expect(
      processor(extractor, wrongModel).process(run, context().value)
    ).rejects.toThrow("revisions changed");

    const cpuOnly = new FindingInference(() => null, 128 * 1024, {
      providers: ["CPUExecutionProvider"],
    });
    await expect(
      processor(extractor, cpuOnly).process(run, context().value)
    ).rejects.toThrow("revisions changed");

    await expect(
      processor(extractor, new FindingInference(() => null)).process(
        { ...run, configRevision: "stale-config" },
        context().value
      )
    ).rejects.toThrow("revisions changed");
  });

  it("coalesces sparse refinement windows and uses smaller dense chunks", async () => {
    const longRun: ContentAnalysisRun = {
      ...run,
      sourceDurationSeconds: 20_000,
    };
    const extractor = new RecordingExtractor([], []);
    const coarse: ContentAnalysisObservationChunk = {
      phase: "coarse",
      chunkIndex: 0,
      startSeconds: 0,
      endSeconds: 20_000,
      sampledFrames: 10_000,
      positiveFrames: 1_001,
      findings: Array.from({ length: 1_001 }, (_, index) => ({
        timestampSeconds: index * 10,
        category: "BUTTOCKS_EXPOSED" as const,
        score: 0.5,
      })),
    };
    const state = context([coarse], {
      version: 1,
      phase: "refining",
      scannedSeconds: 20_000,
      sampledFrames: 10_000,
      positiveFrames: 1_001,
      cursor: { chunkIndex: 0 },
    });

    await processor(
      extractor,
      new FindingInference(() => null),
      async () => new Blob(["frame"]),
      longRun
    ).process(longRun, state.value);

    expect(extractor.requests[0]?.windows?.length).toBeLessThanOrEqual(1_000);
    expect(extractor.requests[0]?.chunkDurationSeconds).toBe(30);
  });

  it("keeps encoded image bytes below the advertised multipart batch budget", async () => {
    const disposed: number[] = [];
    const extractor = new RecordingExtractor(
      [chunk(0, 0, 6, [0, 2, 4], disposed)],
      []
    );
    const inference = new FindingInference(() => null, 128 * 1024);
    const state = context();

    await processor(
      extractor,
      inference,
      async () => new Blob([new Uint8Array(40 * 1024)], { type: "image/png" })
    ).process(run, state.value);

    expect(inference.requests.map((request) => request.items.length)).toEqual([
      1, 1, 1,
    ]);
    expect(disposed).toEqual([0]);
  });

  it("retries from the next staged chunk through the durable handler", async () => {
    let now = new Date("2026-08-28T12:00:00Z");
    const disposed: number[] = [];
    const extractor = new RecordingExtractor(
      [
        chunk(0, 0, 6, [0, 2, 4], disposed),
        chunk(1, 6, 12, [6, 8, 10], disposed),
      ],
      []
    );
    let failedSecondChunk = false;
    const inference = new FindingInference((id) => {
      if (id.includes(":coarse:1:") && !failedSecondChunk) {
        failedSecondChunk = true;
        return { error: "OVERLOADED" };
      }
      return null;
    });
    const contentProcessor = processor(extractor, inference);
    let leaseSequence = 0;
    const durableJobs = new DurableJobsService(new InMemoryDurableJobStore(), {
      now: () => now,
      createLeaseToken: () => `processor-lease-${++leaseSequence}`,
    });
    const runStore = new InMemoryContentAnalysisRunStore(durableJobs, {
      now: () => now,
    });
    const revisions = {
      analyzerRevision: run.analyzerRevision,
      modelRevision: run.modelRevision,
      taxonomyRevision: run.taxonomyRevision,
      configRevision: run.configRevision,
    };
    const handler = new ContentAnalysisHandler({
      runStore,
      loadFreshVideoSource: async () => ({
        id: run.videoId,
        sourceFingerprint: run.sourceFingerprint,
        durationSeconds: run.sourceDurationSeconds,
      }),
      loadCurrentRevisions: async () => revisions,
      processor: contentProcessor.process,
      maxRetries: 1,
      retryDelayMs: 1_000,
    });
    const service = new ContentAnalysisService({
      runStore,
      durableJobs,
      cancellation: handler,
      loadFreshVideoSource: async () => ({
        id: run.videoId,
        sourceFingerprint: run.sourceFingerprint,
        durationSeconds: run.sourceDurationSeconds,
      }),
      loadCurrentRevisions: async () => revisions,
    });
    const worker = new DurableJobWorker(durableJobs, {
      workerId: "processor-worker",
      leaseDurationMs: 30_000,
      heartbeatIntervalMs: 10_000,
      maxRetries: 1,
      retryDelayMs: () => 1_000,
      kinds: ["vision.content-analysis"],
      handlers: {
        "vision.content-analysis": (job, workerContext) =>
          handler.handle(job, workerContext),
      },
      classifyError: (error) => handler.classifyError(error),
    });
    const started = await service.start({
      videoId: run.videoId,
      userId: run.userId,
      profile: run.profile,
      categories: run.requestedCategories,
    });

    await worker.runOnce();
    expect(await service.get(started.run.id, run.userId)).toMatchObject({
      status: "retry_wait",
      sampledFrames: 3,
    });

    now = new Date(now.getTime() + 1_000);
    await worker.runOnce();

    expect(await service.get(started.run.id, run.userId)).toMatchObject({
      status: "completed",
      sampledFrames: 6,
      resultEventCount: 0,
    });
    expect(
      extractor.requests.map((request) => request.startChunkIndex)
    ).toEqual([0, 1]);
    expect(await runStore.listObservationChunks(started.run.id)).toHaveLength(
      2
    );
  });
});
