import { describe, expect, it } from "bun:test";
import {
  DurableJobsService,
  DurableJobWorker,
  InMemoryDurableJobStore,
} from "@/modules/durable-jobs";
import {
  ContentAnalysisHandler,
  ContentAnalysisService,
  InMemoryContentAnalysisRunStore,
  RetryableContentAnalysisError,
  type ContentAnalysisProcessor,
  type ContentAnalysisVideoSource,
} from "@/modules/content-analysis";

const baseVideo: ContentAnalysisVideoSource = {
  id: 42,
  sourceFingerprint: "partial-sha256-v1:video-hash",
  durationSeconds: 10_800,
};

function createHarness(
  processor: ContentAnalysisProcessor = async () => ({ events: [] })
) {
  let now = new Date("2026-08-28T12:00:00.000Z");
  let video: ContentAnalysisVideoSource | null = { ...baseVideo };
  let revisions = {
    analyzerRevision: "nudity-v1",
    modelRevision: "nudenet-640m",
    taxonomyRevision: "nudenet-v1",
    configRevision: "balanced-v1",
  };
  let lease = 0;
  const durableJobs = new DurableJobsService(new InMemoryDurableJobStore(), {
    now: () => now,
    createLeaseToken: () => `lease-${++lease}`,
  });
  const runStore = new InMemoryContentAnalysisRunStore(durableJobs, {
    now: () => now,
  });
  const handler = new ContentAnalysisHandler({
    runStore,
    loadFreshVideoSource: async () => video,
    loadCurrentRevisions: async () => revisions,
    processor,
    maxRetries: 1,
  });
  const service = new ContentAnalysisService({
    runStore,
    durableJobs,
    cancellation: handler,
    loadFreshVideoSource: async () => video,
    loadCurrentRevisions: async () => revisions,
  });
  const worker = new DurableJobWorker(durableJobs, {
    workerId: "content-worker-a",
    leaseDurationMs: 30_000,
    heartbeatIntervalMs: 10_000,
    maxRetries: 1,
    retryDelayMs: () => 1_000,
    kinds: ["vision.content-analysis"],
    handlers: {
      "vision.content-analysis": (job, context) => handler.handle(job, context),
    },
    classifyError: (error) => handler.classifyError(error),
  });

  return {
    durableJobs,
    handler,
    runStore,
    service,
    worker,
    advance(milliseconds: number) {
      now = new Date(now.getTime() + milliseconds);
    },
    setVideo(value: ContentAnalysisVideoSource | null) {
      video = value;
    },
    setAnalyzerRevision(analyzerRevision: string) {
      revisions = { ...revisions, analyzerRevision };
    },
  };
}

describe("durable content analysis", () => {
  it("reuses semantically equivalent active and completed runs unless forced", async () => {
    const { service, worker } = createHarness();
    const input = {
      videoId: 42,
      userId: 7,
      profile: "balanced" as const,
      categories: ["BUTTOCKS_EXPOSED" as const],
    };

    const first = await service.start(input);
    const activeDuplicate = await service.start(input);
    expect(activeDuplicate).toMatchObject({ reused: true });
    expect(activeDuplicate.run.id).toBe(first.run.id);

    await worker.runOnce();
    const completedDuplicate = await service.start(input);
    expect(completedDuplicate.run.id).toBe(first.run.id);
    expect(completedDuplicate.reused).toBe(true);

    const forced = await service.start({ ...input, force: true });
    expect(forced.run.id).not.toBe(first.run.id);
    expect(forced.reused).toBe(false);
  });

  it("rejects reuse of one idempotency key for different semantics", async () => {
    const { service } = createHarness();
    await service.start({
      videoId: 42,
      userId: 7,
      profile: "balanced",
      idempotencyKey: "request-1",
    });

    await expect(
      service.start({
        videoId: 42,
        userId: 7,
        profile: "thorough",
        idempotencyKey: "request-1",
      })
    ).rejects.toThrow("different analysis request");
    await expect(
      service.start({
        videoId: 42,
        userId: 7,
        profile: "balanced",
        force: true,
        idempotencyKey: "request-1",
      })
    ).rejects.toThrow("different analysis request");
  });

  it("rejects duplicate requested categories before enqueue", async () => {
    const { service } = createHarness();
    await expect(
      service.start({
        videoId: 42,
        userId: 7,
        categories: ["ANUS_EXPOSED", "ANUS_EXPOSED"],
      })
    ).rejects.toThrow("categories must not contain duplicates");
  });

  it("treats a changed effective duration as a different source generation", async () => {
    const harness = createHarness();
    const first = await harness.service.start({ videoId: 42, userId: 7 });
    harness.setVideo({ ...baseVideo, durationSeconds: 10_799 });

    const changed = await harness.service.start({ videoId: 42, userId: 7 });

    expect(changed.reused).toBe(false);
    expect(changed.run.id).not.toBe(first.run.id);
    expect(changed.run.sourceDurationSeconds).toBe(10_799);
  });

  it("publishes an empty generation as a successful zero-result run", async () => {
    const { runStore, service, worker } = createHarness();
    const { run } = await service.start({
      videoId: 42,
      userId: 7,
      profile: "balanced",
    });

    await worker.runOnce();

    expect(await service.get(run.id, 7)).toMatchObject({
      status: "completed",
      phase: "completed",
      isPublished: true,
      resultEventCount: 0,
    });
    expect(await runStore.listEvents(run.id)).toEqual([]);
  });

  it("atomically acknowledges publication so a post-commit crash cannot replay it", async () => {
    let processCount = 0;
    const harness = createHarness(async () => {
      processCount += 1;
      return {
        events: [
          {
            generationKey: "episode-1",
            startSeconds: 10,
            peakSeconds: 12,
            endSeconds: 15,
            categorySummary: [
              {
                category: "BUTTOCKS_EXPOSED",
                count: 3,
                maxScore: 0.9,
                meanScore: 0.8,
              },
            ],
          },
        ],
      };
    });
    const { run } = await harness.service.start({
      videoId: 42,
      userId: 7,
      profile: "balanced",
    });
    const claimed = await harness.durableJobs.claim({
      workerId: "crashed-worker",
      leaseDurationMs: 10,
      kinds: ["vision.content-analysis"],
    });
    await harness.handler.handle(claimed!, {
      signal: new AbortController().signal,
      heartbeat: async () => undefined,
      checkpoint: async () => undefined,
    });

    expect(await harness.durableJobs.get(claimed!.id)).toMatchObject({
      status: "completed",
    });

    harness.advance(11);
    await harness.worker.runOnce();

    expect(processCount).toBe(1);
    expect(await harness.runStore.listEvents(run.id)).toHaveLength(1);
    expect(await harness.durableJobs.get(claimed!.id)).toMatchObject({
      status: "completed",
    });
  });

  it("aborts local work immediately on cancellation and never publishes", async () => {
    let started!: () => void;
    const processingStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const harness = createHarness(
      async (_run, context) =>
        new Promise((resolve, reject) => {
          started();
          context.signal.addEventListener(
            "abort",
            () => reject(context.signal.reason),
            { once: true }
          );
          void resolve;
        })
    );
    const { run } = await harness.service.start({
      videoId: 42,
      userId: 7,
      profile: "balanced",
    });
    const processing = harness.worker.runOnce();
    await processingStarted;

    await harness.service.cancel(run.id, 7);
    await processing;

    expect(await harness.service.get(run.id, 7)).toMatchObject({
      status: "cancelled",
      isPublished: false,
    });
    expect(await harness.runStore.listEvents(run.id)).toEqual([]);
  });

  it("fails without publication when fingerprint or duration changed", async () => {
    const harness = createHarness();
    const { run } = await harness.service.start({
      videoId: 42,
      userId: 7,
      profile: "balanced",
    });
    harness.setVideo({
      ...baseVideo,
      sourceFingerprint: "partial-sha256-v1:replacement-hash",
      durationSeconds: 10_700,
    });

    await harness.worker.runOnce();

    expect(await harness.service.get(run.id, 7)).toMatchObject({
      status: "failed",
      errorCode: "CONTENT_SOURCE_CHANGED",
      isPublished: false,
    });
  });

  it("fails when analyzer revisions drift before execution", async () => {
    const harness = createHarness();
    const { run } = await harness.service.start({
      videoId: 42,
      userId: 7,
      profile: "balanced",
    });
    harness.setAnalyzerRevision("nudity-v2");

    await harness.worker.runOnce();

    expect(await harness.service.get(run.id, 7)).toMatchObject({
      status: "failed",
      errorCode: "ANALYZER_CHANGED",
      isPublished: false,
    });
  });

  it("rejects publication after the lease expires", async () => {
    let harness: ReturnType<typeof createHarness>;
    harness = createHarness(async () => {
      harness.advance(31_000);
      return { events: [] };
    });
    const { run } = await harness.service.start({
      videoId: 42,
      userId: 7,
      profile: "balanced",
    });
    const job = await harness.durableJobs.claim({
      workerId: "stale-worker",
      leaseDurationMs: 30_000,
      kinds: ["vision.content-analysis"],
    });

    await expect(
      harness.handler.handle(job!, {
        signal: new AbortController().signal,
        heartbeat: async () => undefined,
        checkpoint: async () => undefined,
      })
    ).rejects.toThrow("lease is no longer active");
    expect(await harness.runStore.listEvents(run.id)).toEqual([]);
    expect((await harness.runStore.findById(run.id))!.isPublished).toBe(false);
  });

  it("bounds persisted retries for retryable infrastructure failures", async () => {
    const harness = createHarness(async () => {
      throw new RetryableContentAnalysisError(
        "VISION_SERVICE_UNAVAILABLE",
        "Vision service unavailable"
      );
    });
    const { run } = await harness.service.start({
      videoId: 42,
      userId: 7,
      profile: "balanced",
    });

    await harness.worker.runOnce();
    expect(await harness.service.get(run.id, 7)).toMatchObject({
      status: "retry_wait",
      retryCount: 1,
    });

    harness.advance(1_000);
    await harness.worker.runOnce();
    expect(await harness.service.get(run.id, 7)).toMatchObject({
      status: "failed",
      retryCount: 1,
      errorCode: "VISION_SERVICE_UNAVAILABLE",
    });
  });

  it("bounds repeated expired-lease crash recovery attempts", async () => {
    let processCount = 0;
    const harness = createHarness(async () => {
      processCount += 1;
      return { events: [] };
    });
    const { run } = await harness.service.start({
      videoId: 42,
      userId: 7,
      profile: "balanced",
    });

    await harness.durableJobs.claim({
      workerId: "crashed-1",
      leaseDurationMs: 10,
      kinds: ["vision.content-analysis"],
    });
    harness.advance(11);
    await harness.durableJobs.claim({
      workerId: "crashed-2",
      leaseDurationMs: 10,
      kinds: ["vision.content-analysis"],
    });
    harness.advance(11);

    await harness.worker.runOnce();

    expect(processCount).toBe(0);
    expect(await harness.service.get(run.id, 7)).toMatchObject({
      status: "failed",
      errorCode: "JOB_RETRY_BUDGET_EXHAUSTED",
    });
  });

  it("rejects regressive checkpoints before they can be persisted", async () => {
    const harness = createHarness(async (_run, context) => {
      await context.checkpoint({
        phase: "analyzing",
        scannedSeconds: 20,
        sampledFrames: 10,
        positiveFrames: 2,
        cursor: { chunkIndex: 2, itemOffset: 4 },
      });
      await context.checkpoint({
        phase: "extracting",
        scannedSeconds: 19,
        sampledFrames: 9,
        positiveFrames: 1,
        cursor: { chunkIndex: 2, itemOffset: 3 },
      });
      return { events: [] };
    });
    const { run } = await harness.service.start({ videoId: 42, userId: 7 });

    await harness.worker.runOnce();

    expect(await harness.service.get(run.id, 7)).toMatchObject({
      status: "failed",
      errorCode: "CONTENT_ANALYSIS_FAILED",
      scannedSeconds: 20,
      sampledFrames: 10,
      positiveFrames: 2,
      isPublished: false,
    });
  });

  it("allows a phase-local chunk cursor to restart when refinement begins", async () => {
    const harness = createHarness(async (_run, context) => {
      await context.checkpoint({
        phase: "analyzing",
        scannedSeconds: 10_800,
        sampledFrames: 50,
        positiveFrames: 2,
        cursor: { chunkIndex: 36 },
      });
      await context.checkpoint({
        phase: "refining",
        scannedSeconds: 10_800,
        sampledFrames: 51,
        positiveFrames: 3,
        cursor: { chunkIndex: 1 },
      });
      await context.checkpoint({
        phase: "condensing",
        scannedSeconds: 10_800,
        sampledFrames: 51,
        positiveFrames: 3,
      });
      return { events: [] };
    });
    const { run } = await harness.service.start({ videoId: 42, userId: 7 });

    await harness.worker.runOnce();

    expect(await harness.service.get(run.id, 7)).toMatchObject({
      status: "completed",
      phase: "completed",
      sampledFrames: 51,
      positiveFrames: 3,
    });
  });

  it("stages media-free observation chunks idempotently under the active lease", async () => {
    const harness = createHarness();
    const { run } = await harness.service.start({
      videoId: 42,
      userId: 7,
      categories: ["BUTTOCKS_EXPOSED"],
    });
    const job = await harness.durableJobs.claim({
      workerId: "observation-worker",
      leaseDurationMs: 30_000,
      kinds: ["vision.content-analysis"],
    });
    const lease = { durableJobId: job!.id, leaseToken: job!.leaseToken! };
    const chunk = {
      phase: "coarse" as const,
      chunkIndex: 0,
      startSeconds: 0,
      endSeconds: 300,
      sampledFrames: 150,
      positiveFrames: 1,
      findings: [
        {
          timestampSeconds: 12,
          category: "BUTTOCKS_EXPOSED" as const,
          score: 0.91,
          providerLabel: "BUTTOCKS_EXPOSED",
        },
      ],
    };

    expect(
      await harness.runStore.stageObservationChunk(run.id, lease, chunk)
    ).toBe(true);
    expect(
      await harness.runStore.stageObservationChunk(run.id, lease, {
        ...chunk,
        positiveFrames: 2,
        findings: [
          ...chunk.findings,
          { ...chunk.findings[0]!, timestampSeconds: 14, score: 0.8 },
        ],
      })
    ).toBe(true);
    expect(await harness.runStore.listObservationChunks(run.id)).toEqual([
      {
        ...chunk,
        positiveFrames: 2,
        findings: [
          ...chunk.findings,
          { ...chunk.findings[0]!, timestampSeconds: 14, score: 0.8 },
        ],
      },
    ]);

    await expect(
      harness.runStore.stageObservationChunk(run.id, lease, {
        ...chunk,
        findings: [{ ...chunk.findings[0]!, path: "/private/frame.jpg" }],
      } as never)
    ).rejects.toThrow("Invalid content analysis observation chunk");

    harness.advance(30_001);
    expect(
      await harness.runStore.stageObservationChunk(run.id, lease, chunk)
    ).toBe(false);
  });

  it("rejects malformed event summaries before publication", async () => {
    const harness = createHarness(async () => ({
      events: [
        {
          generationKey: "episode-1",
          startSeconds: 10,
          peakSeconds: 11,
          endSeconds: 12,
          categorySummary: [
            {
              category: "BUTTOCKS_EXPOSED",
              count: 2,
              maxScore: 0.7,
              meanScore: 0.8,
              providerLabel: "provider-label",
            },
            {
              category: "BUTTOCKS_EXPOSED",
              count: 1,
              maxScore: 0.6,
              meanScore: 0.5,
            },
          ],
        },
      ],
    }));
    const { run } = await harness.service.start({
      videoId: 42,
      userId: 7,
      categories: ["BUTTOCKS_EXPOSED"],
    });

    await harness.worker.runOnce();

    expect(await harness.service.get(run.id, 7)).toMatchObject({
      status: "failed",
      errorCode: "CONTENT_ANALYSIS_FAILED",
      isPublished: false,
    });
    expect(await harness.runStore.listEvents(run.id)).toEqual([]);
  });

  it("does not persist internal details from unexpected processor errors", async () => {
    const harness = createHarness(async () => {
      throw new Error(
        "ffprobe failed for /private/library/owner-only-video.mp4"
      );
    });
    const { run } = await harness.service.start({ videoId: 42, userId: 7 });

    await harness.worker.runOnce();

    const failed = await harness.service.get(run.id, 7);
    expect(failed).toMatchObject({
      status: "failed",
      errorCode: "CONTENT_ANALYSIS_FAILED",
      errorMessage: "Content analysis failed",
      isPublished: false,
    });
    expect(JSON.stringify(failed)).not.toContain("owner-only-video.mp4");
  });
});
