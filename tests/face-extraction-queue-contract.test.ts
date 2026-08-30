import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";

process.env.POSTGRES_USER ||= "face-queue-test";
process.env.POSTGRES_PASSWORD ||= "face-queue-test";
process.env.SESSION_SECRET ||=
  "face-queue-test-session-secret-at-least-32-characters";
process.env.DEMO_MODE = "false";

const updateWhere = mock(async () => undefined);
const detectFacesFromFile = mock(async (_path: string) => ({
  faces: [
    {
      bbox: [320, 180, 960, 540],
      embedding: Array.from({ length: 512 }, () => 0.01),
      det_score: 0.98,
    },
  ],
  image_width: 1280,
  image_height: 720,
  processing_time_ms: 10,
}));

mock.module("@/config/drizzle", () => ({
  db: {
    update: () => ({
      set: () => ({ where: updateWhere }),
    }),
  },
}));

mock.module("@/modules/face-recognition/face-recognition.client", () => ({
  getFaceRecognitionClient: () => ({ detectFacesFromFile }),
}));

mock.module("@/utils/logger", () => ({
  logger: {
    debug: mock(() => undefined),
    error: mock(() => undefined),
    info: mock(() => undefined),
    warn: mock(() => undefined),
  },
}));

let FaceExtractionQueueService: typeof import("@/modules/face-recognition/face-extraction-queue.service").FaceExtractionQueueService;

beforeAll(async () => {
  ({ FaceExtractionQueueService } =
    await import("@/modules/face-recognition/face-extraction-queue.service"));
});

beforeEach(() => {
  updateWhere.mockClear();
  detectFacesFromFile.mockReset();
  detectFacesFromFile.mockImplementation(async () => ({
    faces: [
      {
        bbox: [320, 180, 960, 540],
        embedding: Array.from({ length: 512 }, () => 0.01),
        det_score: 0.98,
      },
    ],
    image_width: 1280,
    image_height: 720,
    processing_time_ms: 10,
  }));
});

describe("FaceExtractionQueueService inference contract", () => {
  it("normalizes pixel coordinates using the dimensions returned by the inference service", async () => {
    const service = new FaceExtractionQueueService();

    const detections = await service.processFrames(9, [
      {
        filePath: "/tmp/resized-frame.jpg",
        timestampSeconds: 15,
        frameIndex: 3,
        width: 0,
        height: 0,
      },
    ]);

    expect(detections).toHaveLength(1);
    expect(detections[0]?.bbox).toEqual([0.25, 0.25, 0.75, 0.75]);
  });

  it("fails when no frame inference succeeds", async () => {
    detectFacesFromFile.mockImplementation(async () => {
      throw new Error("face service disconnected");
    });
    const service = new FaceExtractionQueueService();

    await expect(
      service.processFrames(9, [
        {
          filePath: "/tmp/frame-1.jpg",
          timestampSeconds: 0,
          frameIndex: 0,
          width: 0,
          height: 0,
        },
        {
          filePath: "/tmp/frame-2.jpg",
          timestampSeconds: 10,
          frameIndex: 1,
          width: 0,
          height: 0,
        },
      ])
    ).rejects.toThrow("No face inference succeeded");
  });

  it("allows a successful inference that legitimately finds no face", async () => {
    detectFacesFromFile.mockImplementation(async () => ({
      faces: [],
      image_width: 1280,
      image_height: 720,
      processing_time_ms: 10,
    }));
    const service = new FaceExtractionQueueService();

    await expect(
      service.processFrames(9, [
        {
          filePath: "/tmp/frame-without-face.jpg",
          timestampSeconds: 0,
          frameIndex: 0,
          width: 0,
          height: 0,
        },
      ])
    ).resolves.toEqual([]);
  });

  it("fails when extraction produced no frames to infer", async () => {
    const service = new FaceExtractionQueueService();

    await expect(service.processFrames(9, [])).rejects.toThrow(
      "No frames available for face inference"
    );
  });
});
