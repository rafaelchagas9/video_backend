import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import * as actualFs from "fs";
import {
  faceExtractionJobsTable,
  videoCreatorsTable,
  videoFaceDetectionsTable,
} from "@/database/schema";
import type { RawFaceDetection } from "@/modules/face-recognition/face-recognition.types";

process.env.POSTGRES_USER ||= "face-publication-test";
process.env.POSTGRES_PASSWORD ||= "face-publication-test";
process.env.SESSION_SECRET ||=
  "face-publication-test-session-secret-at-least-32-characters";
process.env.DEMO_MODE = "false";

type DetectionRow = {
  id: number;
  videoId: number;
  faceExtractionJobId: number | null;
  isPublished: boolean;
  embedding: string;
  timestampSeconds: number;
  frameIndex: number | null;
  bboxX1: number;
  bboxY1: number;
  bboxX2: number;
  bboxY2: number;
  detScore: number;
  matchedCreatorId: number | null;
  matchConfidence: number | null;
  matchStatus: string;
  createdAt: Date;
  updatedAt: Date;
};

type PublicationState = {
  detections: DetectionRow[];
  jobs: Array<{ id: number; videoId: number; isPublished: boolean }>;
  videoCreators: Array<{ videoId: number; creatorId: number }>;
};

const oldDetection = (): DetectionRow => ({
  id: 41,
  videoId: 7,
  faceExtractionJobId: null,
  isPublished: true,
  embedding: JSON.stringify(Array.from({ length: 512 }, () => 0.02)),
  timestampSeconds: 12,
  frameIndex: 1,
  bboxX1: 0.1,
  bboxY1: 0.1,
  bboxX2: 0.3,
  bboxY2: 0.4,
  detScore: 0.91,
  matchedCreatorId: 2,
  matchConfidence: 0.8,
  matchStatus: "pending",
  createdAt: new Date("2026-08-28T12:00:00.000Z"),
  updatedAt: new Date("2026-08-28T12:00:00.000Z"),
});

const matchingDetection = (): RawFaceDetection => ({
  embedding: Array.from({ length: 512 }, () => 0.01),
  timestampSeconds: 30,
  frameIndex: 3,
  bbox: [0.2, 0.2, 0.4, 0.5],
  detScore: 0.99,
});

let state: PublicationState;
let nextDetectionId = 100;
let executeResult: Array<Record<string, unknown>> = [];
let failCommit = false;
const runId = 52;

function publishedDetections(current: PublicationState): DetectionRow[] {
  return current.detections.filter(
    ({ videoId, isPublished }) => videoId === 7 && isPublished
  );
}

function selectFrom(current: PublicationState) {
  let table: unknown;
  const chain: any = {
    from(value: unknown) {
      table = value;
      return chain;
    },
    where() {
      return chain;
    },
    limit: async () =>
      table === videoFaceDetectionsTable
        ? publishedDetections(current).slice(0, 1)
        : [],
    orderBy: async () =>
      table === videoFaceDetectionsTable ? publishedDetections(current) : [],
    then(resolve: (value: unknown[]) => unknown) {
      const rows =
        table === videoFaceDetectionsTable ? publishedDetections(current) : [];
      return Promise.resolve(rows).then(resolve);
    },
  };
  return chain;
}

function transactionAdapter(draft: PublicationState) {
  return {
    insert: (table: unknown) => ({
      values: (input: any[] | any) => {
        const values = Array.isArray(input) ? input : [input];
        if (table === videoFaceDetectionsTable) {
          draft.detections.push(
            ...values.map((value) => ({
              ...value,
              id: nextDetectionId++,
              createdAt: new Date(),
              updatedAt: new Date(),
            }))
          );
        }
        if (table === videoCreatorsTable) {
          draft.videoCreators.push(...values);
        }
        return { onConflictDoNothing: async () => undefined };
      },
    }),
    update: (table: unknown) => ({
      set: (values: { isPublished: boolean }) => ({
        where: () => {
          let applied = false;
          let updatedJobs: Array<{ id: number }> = [];
          const apply = () => {
            if (applied) return;
            applied = true;
            if (table === videoFaceDetectionsTable) {
              for (const detection of draft.detections) {
                if (detection.videoId !== 7) continue;
                detection.isPublished = values.isPublished
                  ? detection.faceExtractionJobId === runId
                  : false;
              }
            }
            if (table === faceExtractionJobsTable) {
              for (const job of draft.jobs) {
                if (job.videoId !== 7) continue;
                job.isPublished = values.isPublished ? job.id === runId : false;
                if (values.isPublished && job.id === runId) {
                  updatedJobs.push({ id: job.id });
                }
              }
            }
          };
          return {
            then(
              resolve: (value: void) => unknown,
              reject: (reason: unknown) => unknown
            ) {
              apply();
              return Promise.resolve().then(resolve, reject);
            },
            returning: async () => {
              apply();
              return updatedJobs;
            },
          };
        },
      }),
    }),
    delete: () => {
      throw new Error("Face publication must never delete immutable results");
    },
  };
}

const transaction = mock(async (callback: (tx: any) => Promise<void>) => {
  const draft: PublicationState = structuredClone(state);
  await callback(transactionAdapter(draft));
  if (failCommit) throw new Error("commit failed");
  state = draft;
});

const dbMock = {
  execute: mock(async () => executeResult),
  select: () => selectFrom(state),
  transaction,
};

const fsMock = {
  ...actualFs,
  existsSync: () => true,
  mkdirSync: () => undefined,
};

mock.module("@/config/drizzle", () => ({ db: dbMock }));
mock.module("fs", () => ({ ...fsMock, default: fsMock }));
mock.module("@/utils/logger", () => ({
  logger: {
    debug: mock(() => undefined),
    error: mock(() => undefined),
    info: mock(() => undefined),
    warn: mock(() => undefined),
  },
}));

let FaceRecognitionService: typeof import("@/modules/face-recognition/face-recognition.service").FaceRecognitionService;

beforeAll(async () => {
  ({ FaceRecognitionService } =
    await import("@/modules/face-recognition/face-recognition.service"));
});

beforeEach(() => {
  state = {
    detections: [oldDetection()],
    jobs: [
      { id: 51, videoId: 7, isPublished: false },
      { id: runId, videoId: 7, isPublished: false },
    ],
    videoCreators: [],
  };
  nextDetectionId = 100;
  executeResult = [];
  failCommit = false;
  transaction.mockClear();
  dbMock.execute.mockClear();
});

describe("FaceRecognitionService atomic face publication", () => {
  it("publishes a legitimate empty run while preserving old results as immutable history", async () => {
    const service = new FaceRecognitionService();

    await service.autoMatchVideoFaces(7, [], undefined, undefined, {
      runId,
      guard: async () => undefined,
    });

    await expect(service.getVideoFaceDetections(7)).resolves.toEqual([]);
    expect(state.detections).toHaveLength(1);
    expect(state.detections[0]?.isPublished).toBe(false);
    expect(state.jobs.find(({ id }) => id === runId)?.isPublished).toBe(true);
  });

  it("keeps the previous generation published when the guard rejects stale work", async () => {
    const service = new FaceRecognitionService();
    const guard = mock(async () => {
      throw new Error("lease lost");
    });

    await expect(
      service.autoMatchVideoFaces(7, [matchingDetection()], 0.6, 0.95, {
        runId,
        guard,
      })
    ).rejects.toThrow("lease lost");

    expect(guard).toHaveBeenCalledTimes(1);
    await expect(service.getVideoFaceDetections(7)).resolves.toEqual([
      oldDetection(),
    ]);
    expect(state.detections).toHaveLength(1);
  });

  it("calculates every match before opening the publication transaction", async () => {
    dbMock.execute.mockImplementationOnce(async () => {
      throw new Error("similarity calculation failed");
    });
    const service = new FaceRecognitionService();

    await expect(
      service.autoMatchVideoFaces(7, [matchingDetection()], 0.6, 0.95, {
        runId,
        guard: async () => undefined,
      })
    ).rejects.toThrow("similarity calculation failed");

    expect(transaction).not.toHaveBeenCalled();
    await expect(service.getVideoFaceDetections(7)).resolves.toEqual([
      oldDetection(),
    ]);
  });

  it("publishes new detections under their run without deleting immutable history", async () => {
    executeResult = [
      {
        creator_id: 9,
        creator_name: "Creator",
        similarity: 0.9,
        reference_embedding_id: 3,
        reference_source_type: "manual_upload",
      },
    ];
    const service = new FaceRecognitionService();

    await service.autoMatchVideoFaces(7, [matchingDetection()], 0.6, 0.95, {
      runId,
      guard: async () => undefined,
    });

    const published = await service.getVideoFaceDetections(7);
    expect(published).toHaveLength(1);
    expect(published[0]).toEqual(
      expect.objectContaining({
        id: 100,
        faceExtractionJobId: runId,
        isPublished: true,
        matchedCreatorId: 9,
      })
    );
    expect(state.detections).toHaveLength(2);
    expect(state.detections.find(({ id }) => id === 41)?.isPublished).toBe(
      false
    );
  });

  it("rolls back staged results when the publication transaction cannot commit", async () => {
    executeResult = [
      {
        creator_id: 9,
        creator_name: "Creator",
        similarity: 0.9,
        reference_embedding_id: 3,
        reference_source_type: "manual_upload",
      },
    ];
    failCommit = true;
    const service = new FaceRecognitionService();

    await expect(
      service.autoMatchVideoFaces(7, [matchingDetection()], 0.6, 0.95, {
        runId,
        guard: async () => undefined,
      })
    ).rejects.toThrow("commit failed");

    await expect(service.getVideoFaceDetections(7)).resolves.toEqual([
      oldDetection(),
    ]);
    expect(state.detections).toHaveLength(1);
  });
});
