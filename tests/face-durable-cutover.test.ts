import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import * as actualFs from "fs";

process.env.POSTGRES_USER ||= "face-cutover-test";
process.env.POSTGRES_PASSWORD ||= "face-cutover-test";
process.env.SESSION_SECRET ||=
  "face-cutover-test-session-secret-at-least-32-characters";
process.env.DEMO_MODE = "false";

const queueExtraction = mock(async (_videoId: number) => ({ id: 71 }));
const getLatestJob = mock(async (videoId: number) => ({
  id: 71,
  videoId,
  status: "processing",
}));
const clearDurableQueue = mock(async () => undefined);
const legacyQueueExtraction = mock(async () => undefined);
const legacyClearQueue = mock(async () => undefined);
const extractFrames = mock(async () => ({
  videoId: 42,
  frames: [
    {
      filePath: "/tmp/shared-frame.jpg",
      timestampSeconds: 10,
      frameIndex: 0,
      width: 1920,
      height: 1080,
    },
  ],
  totalFrames: 1,
  extractionTimeMs: 1,
  tempDirectory: "/tmp/shared-frames",
}));
const cleanupFrames = mock(async () => undefined);
const saveFromFrame = mock(async () => undefined);
const assembleFromFrames = mock(async () => undefined);

mock.module(
  "@/modules/face-recognition/face-extraction-durable.service",
  () => ({
    getDurableFaceExtractionQueue: () => ({
      queueExtraction,
      getLatestJob,
      clearQueue: clearDurableQueue,
    }),
  })
);

mock.module("@/modules/face-recognition/face-extraction-queue.service", () => ({
  getFaceExtractionQueue: () => ({
    queueExtraction: legacyQueueExtraction,
    clearQueue: legacyClearQueue,
  }),
}));

mock.module("@/modules/frame-extraction", () => ({
  getFrameExtractionService: () => ({
    extractFrames,
    cleanupFrames,
    findClosestFrame: (frames: unknown[]) => frames[0] ?? null,
  }),
}));

mock.module("@/modules/thumbnails/thumbnails.service", () => ({
  thumbnailsService: { saveFromFrame },
}));

mock.module("@/modules/storyboards/storyboards.service", () => ({
  storyboardsService: { assembleFromFrames },
}));

mock.module("@/config/drizzle", () => ({
  db: new Proxy(
    {},
    {
      get() {
        throw new Error("legacy face status database path used");
      },
    }
  ),
}));

mock.module("@/utils/logger", () => ({
  logger: {
    debug: mock(() => undefined),
    error: mock(() => undefined),
    info: mock(() => undefined),
    warn: mock(() => undefined),
  },
}));

mock.module("@/utils/performance-profiler", () => ({
  recordPerfStage: mock(async () => undefined),
}));

const fsMock = {
  ...actualFs,
  existsSync: () => true,
  mkdirSync: () => undefined,
};
mock.module("fs", () => ({ ...fsMock, default: fsMock }));

let FaceRecognitionService: typeof import("@/modules/face-recognition/face-recognition.service").FaceRecognitionService;

beforeAll(async () => {
  ({ FaceRecognitionService } =
    await import("@/modules/face-recognition/face-recognition.service"));
});

beforeEach(() => {
  for (const fn of [
    queueExtraction,
    getLatestJob,
    clearDurableQueue,
    legacyQueueExtraction,
    legacyClearQueue,
    extractFrames,
    cleanupFrames,
    saveFromFrame,
    assembleFromFrames,
  ]) {
    fn.mockClear();
  }
});

describe("FaceRecognitionService durable queue cutover", () => {
  it("queues on-demand face analysis durably without extracting frames in the request process", async () => {
    const service = new FaceRecognitionService();

    await service.processFacesOnly(42, "/library/live.mp4", 10_800);

    expect(queueExtraction).toHaveBeenCalledWith(42);
    expect(extractFrames).not.toHaveBeenCalled();
    expect(legacyQueueExtraction).not.toHaveBeenCalled();
  });

  it("keeps shared thumbnail/storyboard work but queues face analysis through the durable path", async () => {
    const service = new FaceRecognitionService();

    await service.processVideo(42, "/library/live.mp4", 10_800);

    expect(extractFrames).toHaveBeenCalledTimes(1);
    expect(saveFromFrame).toHaveBeenCalledTimes(1);
    expect(assembleFromFrames).toHaveBeenCalledTimes(1);
    expect(queueExtraction).toHaveBeenCalledWith(42);
    expect(legacyQueueExtraction).not.toHaveBeenCalled();
    expect(cleanupFrames).toHaveBeenCalledWith("/tmp/shared-frames", {
      removeDirectory: true,
    });
  });

  it("cleans shared scan frames when durable enqueueing fails", async () => {
    queueExtraction.mockImplementationOnce(async () => {
      throw new Error("durable enqueue failed");
    });
    const service = new FaceRecognitionService();

    await expect(
      service.processVideo(42, "/library/live.mp4", 10_800)
    ).rejects.toThrow("durable enqueue failed");

    expect(cleanupFrames).toHaveBeenCalledWith("/tmp/shared-frames", {
      removeDirectory: true,
    });
  });

  it("uses the durable projection for status and cancellation", async () => {
    const service = new FaceRecognitionService();

    await expect(service.getFaceExtractionJob(42)).resolves.toMatchObject({
      id: 71,
      videoId: 42,
      status: "processing",
    });
    await service.clearQueue();

    expect(getLatestJob).toHaveBeenCalledWith(42);
    expect(clearDurableQueue).toHaveBeenCalledTimes(1);
    expect(legacyClearQueue).not.toHaveBeenCalled();
  });
});
