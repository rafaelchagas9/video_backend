import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import multipart from "@fastify/multipart";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";

process.env.POSTGRES_USER ||= "face-routes-test";
process.env.POSTGRES_PASSWORD ||= "face-routes-test";
process.env.SESSION_SECRET ||=
  "face-routes-test-session-secret-at-least-32-characters";
process.env.DEMO_MODE = "false";

const setPrimaryEmbedding = mock(async () => undefined);
const deleteCreatorEmbedding = mock(async () => undefined);
const confirmFaceMatch = mock(async () => undefined);
const rejectFaceMatch = mock(async () => undefined);
const processFacesOnly = mock(async () => undefined);
const addCreatorEmbedding = mock(
  async (input: { creatorId: number; sourceType: string }) => ({
    id: 22,
    creatorId: input.creatorId,
    embedding: JSON.stringify(Array.from({ length: 512 }, () => 0.01)),
    sourceType: input.sourceType,
    sourceVideoId: null,
    sourceTimestampSeconds: null,
    detScore: 0.99,
    isPrimary: true,
    estimatedAge: 30,
    estimatedGender: "F",
    thumbnailPath: "/tmp/creator-face.webp",
    createdAt: new Date("2026-08-28T12:00:00.000Z"),
    updatedAt: new Date("2026-08-28T12:00:00.000Z"),
  })
);
const getOrGenerateByDetectionId = mock(async () => ({
  id: 1,
  detectionId: 1,
  filePath: "/tmp",
  fileSizeBytes: 0,
  width: 1,
  height: 1,
  generatedAt: new Date(),
}));

mock.module("@/modules/auth/auth.middleware", () => ({
  authenticateUser: async (request: any) => {
    if (request.headers.authorization !== "Bearer test") {
      const error = new Error("Unauthorized") as Error & {
        statusCode: number;
      };
      error.statusCode = 401;
      throw error;
    }
    request.user = { id: 7 };
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

mock.module("@/utils/telemetry", () => ({
  captureTelemetryException: mock(() => undefined),
}));

mock.module("@/modules/face-recognition/face-recognition.client", () => ({
  getFaceRecognitionClient: () => ({
    healthCheck: async () => ({ status: "healthy", version: "test" }),
    detectFacesFromFile: async () => ({
      faces: [],
      processing_time_ms: 1,
      image_width: 1,
      image_height: 1,
    }),
  }),
}));

mock.module("@/modules/face-recognition/face-images.service", () => ({
  getFaceImagesService: () => ({ getOrGenerateByDetectionId }),
}));

mock.module("@/modules/face-recognition/face-recognition.service", () => ({
  getFaceRecognitionService: () => ({
    addCreatorEmbedding,
    getCreatorEmbeddings: async () => [],
    setPrimaryEmbedding,
    deleteCreatorEmbedding,
    getVideoFaceDetections: async () => [],
    processFacesOnly,
    confirmFaceMatch,
    rejectFaceMatch,
    findVideosWithCreator: async () => [],
    findSimilarCreators: async () => [],
    getFaceExtractionJob: async () => ({
      id: 1,
      videoId: 1,
      status: "completed",
      totalFrames: 1,
      processedFrames: 1,
      facesDetected: 0,
      errorMessage: null,
      retryCount: 0,
      startedAt: new Date(),
      completedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
    clearQueue: async () => undefined,
  }),
}));

mock.module("@/modules/creators/creators.social.service", () => ({
  creatorsSocialService: {
    getGalleryMediaById: async () => ({ file_path: "/tmp" }),
  },
}));

mock.module("@/modules/creators/creators.service", () => ({
  creatorsService: {
    findById: async (id: number) => ({
      id,
      name: "Creator",
      profile_picture_url: null,
    }),
  },
}));

mock.module("@/modules/videos/videos.service", () => ({
  videosService: {
    findById: async (id: number) => ({
      id,
      file_path: "/library/live.mp4",
      duration_seconds: 10_800,
    }),
  },
}));

const emptySelect = () => {
  const chain: any = {
    from: () => chain,
    where: () => chain,
    limit: async () => [],
  };
  return chain;
};

mock.module("@/config/drizzle", () => ({
  db: { select: emptySelect },
}));

let app: ReturnType<typeof Fastify>;

beforeAll(async () => {
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(multipart);
  const { faceRecognitionRoutes } =
    await import("@/modules/face-recognition/face-recognition.routes");
  await app.register(faceRecognitionRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("face recognition route security contract", () => {
  it("requires authentication before serving either biometric image", async () => {
    for (const url of [
      "/creators/11/face-embeddings/22/thumbnail",
      "/faces/44/image",
    ]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, `${url}: ${response.body}`).toBe(401);
    }
    expect(getOrGenerateByDetectionId).not.toHaveBeenCalled();
  });

  it("passes every URL owner scope to biometric mutation methods", async () => {
    const headers = { authorization: "Bearer test" };
    const requests = [
      app.inject({
        method: "PUT",
        url: "/creators/11/face-embeddings/22/primary",
        headers,
      }),
      app.inject({
        method: "DELETE",
        url: "/creators/11/face-embeddings/22",
        headers,
      }),
      app.inject({
        method: "PUT",
        url: "/videos/33/faces/44/confirm",
        headers,
        payload: { creator_id: 55 },
      }),
      app.inject({
        method: "PUT",
        url: "/videos/33/faces/44/reject",
        headers,
      }),
    ];

    const responses = await Promise.all(requests);
    expect(responses.map((response) => response.statusCode)).toEqual([
      200, 200, 200, 200,
    ]);
    expect(setPrimaryEmbedding).toHaveBeenCalledWith(11, 22);
    expect(deleteCreatorEmbedding).toHaveBeenCalledWith(11, 22);
    expect(confirmFaceMatch).toHaveBeenCalledWith(33, 44, 55);
    expect(rejectFaceMatch).toHaveBeenCalledWith(33, 44);
  });

  it("never exposes embeddings, local paths, age, or gender from base64 uploads", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/creators/11/face-embeddings/base64",
      headers: { authorization: "Bearer test" },
      payload: { image_base64: Buffer.from("image").toString("base64") },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({
      id: 22,
      creatorId: 11,
      sourceType: "manual_upload",
      sourceVideoId: null,
      sourceTimestampSeconds: null,
      detScore: 0.99,
      isPrimary: true,
      image_url: "/api/creators/11/face-embeddings/22/thumbnail",
      createdAt: "2026-08-28T12:00:00.000Z",
      updatedAt: "2026-08-28T12:00:00.000Z",
    });
  });

  it("uses the gallery_media source type through the public gallery route", async () => {
    const { addCreatorEmbeddingSchema } =
      await import("@/modules/face-recognition/face-recognition.schemas");
    expect(
      addCreatorEmbeddingSchema.parse({
        creator_id: 11,
        source_type: "gallery_media",
      }).source_type
    ).toBe("gallery_media");

    const response = await app.inject({
      method: "POST",
      url: "/creators/11/face-embeddings/from-gallery/9",
      headers: { authorization: "Bearer test" },
    });

    expect(response.statusCode).toBe(200);
    expect(addCreatorEmbedding).toHaveBeenLastCalledWith(
      expect.objectContaining({ creatorId: 11, sourceType: "gallery_media" })
    );
  });

  it("acknowledges extraction only after the durable request is persisted", async () => {
    processFacesOnly.mockImplementationOnce(async () => {
      throw new Error("durable database unavailable");
    });

    const response = await app.inject({
      method: "POST",
      url: "/videos/42/faces/extract",
      headers: { authorization: "Bearer test" },
    });

    expect(processFacesOnly).toHaveBeenCalledWith(
      42,
      "/library/live.mp4",
      10_800
    );
    expect(response.statusCode).toBe(500);
  });
});
