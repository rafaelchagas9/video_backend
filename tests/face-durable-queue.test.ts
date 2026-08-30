import { beforeAll, describe, expect, it, mock } from "bun:test";
import type {
  DurableJob,
  DurableJobHandlerContext,
} from "@/modules/durable-jobs";
import type { FaceExtractionRunStore } from "@/modules/face-recognition/face-extraction-run.store";

mock.module("@/config/drizzle", () => ({ db: {} }));

let FaceExtractionQueueService: typeof import("@/modules/face-recognition/face-extraction-durable.service").FaceExtractionQueueService;
let VisionServiceUnavailableError: typeof import("@/modules/face-recognition/face-extraction-durable.service").VisionServiceUnavailableError;

beforeAll(async () => {
  ({ FaceExtractionQueueService, VisionServiceUnavailableError } =
    await import("@/modules/face-recognition/face-extraction-durable.service"));
});

const now = new Date("2026-08-28T12:00:00.000Z");

function faceRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 11,
    durableJobId: 7,
    videoId: 42,
    status: "pending",
    totalFrames: null,
    processedFrames: 0,
    facesDetected: 0,
    errorMessage: null,
    retryCount: 0,
    sourceFingerprint: "xxh3-64:video-hash",
    config: {
      detectionThreshold: 0.5,
      intervalSeconds: 8,
      keyframesOnly: true,
      targetWidth: 960,
      outputFormat: "jpg" as const,
      quality: 75,
      similarityThreshold: 0.65,
      autoTagThreshold: 0.75,
    },
    isPublished: false,
    startedAt: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function durableJob(overrides: Partial<DurableJob> = {}): DurableJob {
  return {
    id: 7,
    kind: "vision.face-extraction",
    payload: {
      videoId: 42,
      sourceFingerprint: "xxh3-64:video-hash",
      config: {
        detectionThreshold: 0.5,
        intervalSeconds: 8,
        keyframesOnly: true,
        targetWidth: 960,
        outputFormat: "jpg",
        quality: 75,
        similarityThreshold: 0.65,
        autoTagThreshold: 0.75,
      },
    },
    status: "running",
    attempt: 1,
    workerId: "worker-a",
    leaseToken: "lease-1",
    leaseExpiresAt: new Date("2026-08-28T12:01:00.000Z"),
    checkpoint: null,
    retryCount: 0,
    nextAttemptAt: null,
    lastError: null,
    startedAt: now,
    heartbeatAt: now,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    cancelledAt: null,
    ...overrides,
  };
}

function createHarness(
  options: {
    publishFails?: boolean;
    cleanupFails?: boolean;
    published?: boolean;
    detectFacesFromFile?: (
      imagePath: string,
      signal?: AbortSignal
    ) => Promise<{
      faces: [];
      image_width: number;
      image_height: number;
      processing_time_ms: number;
    }>;
  } = {}
) {
  const enqueue = mock(async (_intent: unknown) => faceRun());
  const latestByVideoId = mock(async () => faceRun());
  const listActive = mock(async () => [faceRun()]);
  const update = mock(async () => undefined);
  const runStore = {
    enqueue,
    findByDurableJobId: mock(async () =>
      faceRun({ isPublished: options.published ?? false })
    ),
    latestByVideoId,
    listActive,
    update,
  } satisfies FaceExtractionRunStore;
  const cleanupFrames = mock(async () => {
    if (options.cleanupFails) throw new Error("cleanup failed");
  });
  const extractFrames = mock(async () => ({
    videoId: 42,
    frames: [
      {
        filePath: "/tmp/job-7/frame.jpg",
        timestampSeconds: 0,
        frameIndex: 0,
        width: 960,
        height: 540,
      },
    ],
    totalFrames: 1,
    extractionTimeMs: 10,
    tempDirectory: "/tmp/job-7",
  }));
  const durableJobs = {
    get: mock(async () => durableJob({ status: "retry_wait", retryCount: 2 })),
    requestCancellation: mock(async () => durableJob({ status: "cancelled" })),
  };
  const publishDetections = mock(async (..._args: unknown[]) => {
    if (options.publishFails) throw new Error("publish failed");
  });
  const queue = new FaceExtractionQueueService(
    {},
    {
      runStore,
      durableJobs: durableJobs as never,
      findVideo: mock(async () => ({
        id: 42,
        file_path: "/library/live.mp4",
        file_hash: "video-hash",
        file_size_bytes: 1234,
        updated_at: "2026-08-28T11:00:00.000Z",
        duration_seconds: 10_800,
      })),
      frameService: {
        extractFrames,
        cleanupFrames,
      } as never,
      faceClient: {
        isAvailable: mock(async () => true),
        detectFacesFromFile: mock(
          options.detectFacesFromFile ??
            (async () => ({
              faces: [],
              image_width: 960,
              image_height: 540,
              processing_time_ms: 1,
            }))
        ),
      } as never,
      publishDetections,
    }
  );
  return {
    queue,
    enqueue,
    extractFrames,
    cleanupFrames,
    update,
    durableJobs,
    publishDetections,
  };
}

describe("durable face extraction queue", () => {
  it("enqueues only ids, configuration, and source fingerprint", async () => {
    const { queue, enqueue } = createHarness();

    await queue.queueExtraction(42);

    expect(enqueue).toHaveBeenCalledTimes(1);
    const intent = enqueue.mock.calls[0]![0];
    expect(intent).toMatchObject({
      videoId: 42,
      sourceFingerprint: "xxh3-64:video-hash",
    });
    expect(JSON.stringify(intent)).not.toContain("file_path");
    expect(JSON.stringify(intent)).not.toContain("/tmp/");
    expect(intent).not.toHaveProperty("frames");
  });

  it("cleans extracted frames in finally and passes the active lease to publication", async () => {
    const { queue, cleanupFrames, publishDetections } = createHarness({
      publishFails: true,
    });
    const checkpoint = mock(async () => undefined);
    const context: DurableJobHandlerContext = {
      signal: new AbortController().signal,
      heartbeat: mock(async () => undefined),
      checkpoint,
    };

    await expect(queue.handleDurableJob(durableJob(), context)).rejects.toThrow(
      "publish failed"
    );
    expect(cleanupFrames).toHaveBeenCalledWith("/tmp/job-7", {
      removeDirectory: true,
    });
    expect(publishDetections.mock.calls[0]?.[4]).toEqual({
      faceExtractionJobId: 11,
      durableJobId: 7,
      leaseToken: "lease-1",
    });
  });

  it("maps the newest durable run to the compatible public status", async () => {
    const { queue } = createHarness();

    expect(await queue.getLatestJob(42)).toMatchObject({
      id: 11,
      videoId: 42,
      status: "pending",
      retryCount: 2,
    });
  });

  it("acknowledges a run already published before a worker restart without extracting again", async () => {
    const { queue, extractFrames, publishDetections } = createHarness({
      published: true,
    });

    await queue.handleDurableJob(durableJob(), {
      signal: new AbortController().signal,
      heartbeat: mock(async () => undefined),
      checkpoint: mock(async () => undefined),
    });

    expect(extractFrames).not.toHaveBeenCalled();
    expect(publishDetections).not.toHaveBeenCalled();
  });

  it("does not let cleanup failure mask the publication failure", async () => {
    const { queue } = createHarness({ publishFails: true, cleanupFails: true });

    await expect(
      queue.handleDurableJob(durableJob(), {
        signal: new AbortController().signal,
        heartbeat: mock(async () => undefined),
        checkpoint: mock(async () => undefined),
      })
    ).rejects.toThrow("publish failed");
  });

  it("propagates inference cancellation without checkpointing or publishing", async () => {
    const controller = new AbortController();
    const cancellation = new Error("face extraction cancelled by worker");
    const { queue, cleanupFrames, publishDetections, update } = createHarness({
      detectFacesFromFile: async (_imagePath, signal) => {
        expect(signal).toBe(controller.signal);
        controller.abort(cancellation);
        throw cancellation;
      },
    });
    const checkpoint = mock(async () => undefined);

    await expect(
      queue.handleDurableJob(durableJob(), {
        signal: controller.signal,
        heartbeat: mock(async () => undefined),
        checkpoint,
      })
    ).rejects.toBe(cancellation);

    expect(checkpoint).not.toHaveBeenCalled();
    expect(publishDetections).not.toHaveBeenCalled();
    expect(cleanupFrames).toHaveBeenCalledWith("/tmp/job-7", {
      removeDirectory: true,
    });
    expect(update.mock.calls).not.toContainEqual([
      11,
      expect.objectContaining({ status: "failed" }),
    ]);
  });

  it("classifies unavailable vision service failures as retryable", () => {
    const { queue } = createHarness();

    expect(queue.classifyError(new VisionServiceUnavailableError())).toEqual({
      retryable: true,
      error: {
        code: "VISION_SERVICE_UNAVAILABLE",
        message: "Vision service unavailable",
      },
    });
  });

  it("clears active runs by cancelling their durable jobs", async () => {
    const { queue, durableJobs } = createHarness();

    await queue.clearQueue();

    expect(durableJobs.requestCancellation).toHaveBeenCalledWith(7);
  });
});
