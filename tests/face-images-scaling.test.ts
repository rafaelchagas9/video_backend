import { beforeAll, describe, expect, it, mock } from "bun:test";
import * as actualFs from "fs";

process.env.POSTGRES_USER ||= "face-images-test";
process.env.POSTGRES_PASSWORD ||= "face-images-test";
process.env.SESSION_SECRET ||=
  "face-images-test-session-secret-at-least-32-characters";
process.env.DEMO_MODE = "false";

const cropFaceThumbnail = mock(async () => ({
  outputPath: "/faces/result.webp",
}));
const cleanupFrames = mock(async () => undefined);

const mockedFs = {
  ...actualFs,
  existsSync: () => true,
  mkdirSync: () => undefined,
  unlinkSync: () => undefined,
  statSync: () => ({ size: 123 }),
  readFileSync: () => Buffer.alloc(0),
};

mock.module("fs", () => ({ ...mockedFs, default: mockedFs }));

mock.module("@/utils/image-processing", () => ({ cropFaceThumbnail }));

mock.module("@/modules/frame-extraction/frame-extraction.service", () => ({
  getFrameExtractionService: () => ({
    extractFrame: async () => "/tmp/full-resolution-frame.jpg",
    cleanupFrames,
  }),
}));

mock.module("@/modules/videos/videos.service", () => ({
  videosService: {
    findById: async () => ({
      id: 7,
      file_path: "/videos/live.mp4",
      width: 3840,
      height: 2160,
    }),
  },
}));

const detection = {
  id: 13,
  videoId: 7,
  embedding: "[]",
  timestampSeconds: 90,
  frameIndex: 9,
  bboxX1: 0.25,
  bboxY1: 0.25,
  bboxX2: 0.75,
  bboxY2: 0.75,
  detScore: 0.98,
  matchedCreatorId: null,
  matchConfidence: null,
  matchStatus: "pending",
  createdAt: new Date(),
  updatedAt: new Date(),
};

const insertedFaceImage = {
  id: 3,
  detectionId: 13,
  filePath: "/faces/result.webp",
  fileSizeBytes: 123,
  width: 128,
  height: 128,
  generatedAt: new Date(),
};

mock.module("@/config/drizzle", () => ({
  db: {
    select: () => {
      const chain: any = {
        from: () => chain,
        where: () => chain,
        limit: async () => [detection],
      };
      return chain;
    },
    insert: () => ({
      values: () => ({ returning: async () => [insertedFaceImage] }),
    }),
  },
}));

mock.module("@/utils/logger", () => ({
  logger: {
    debug: mock(() => undefined),
    error: mock(() => undefined),
    info: mock(() => undefined),
    warn: mock(() => undefined),
  },
}));

let FaceImagesService: typeof import("@/modules/face-recognition/face-images.service").FaceImagesService;

beforeAll(async () => {
  ({ FaceImagesService } =
    await import("@/modules/face-recognition/face-images.service"));
});

describe("FaceImagesService normalized bounding-box contract", () => {
  it("scales the persisted normalized box to the extracted full-resolution frame", async () => {
    const service = new FaceImagesService();

    await service.generateFromDetection(13);

    expect(cropFaceThumbnail).toHaveBeenCalledWith(
      expect.objectContaining({
        inputPath: "/tmp/full-resolution-frame.jpg",
        faceBox: [960, 540, 2880, 1620],
        imageWidth: 3840,
        imageHeight: 2160,
      })
    );
  });
});
