import type { LightMyRequestResponse } from "fastify";
import { mock } from "bun:test";
import { writeFile } from "fs/promises";
import {
  applyTestDatabaseEnv,
  migrateTestDatabase,
  startTestDatabase,
} from "./test-database";
import type { startTestDatabase as startDatabase } from "./test-database";

type TestDatabase = Awaited<ReturnType<typeof startDatabase>>;
type ServerModule = typeof import("@/server");
type AppInstance = Awaited<ReturnType<ServerModule["buildServer"]>>;
type InjectOptions = {
  method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
  url: string;
  payload?: Record<string, unknown> | string | Buffer;
  headers?: Record<string, string>;
};

const TEST_NOW = "2026-05-31T12:00:00.000Z";
export const TEST_THUMBNAIL_PATH = "/tmp/conversor-video-test-thumbnail.jpg";
const TEST_CONVERSION_OUTPUT_PATH = "/tmp/conversor-video-test-converted.mkv";

const createConversionJob = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  video_id: 1,
  status: "pending",
  preset: "720p_h264",
  target_resolution: "720p",
  codec: "h264_vaapi",
  delete_original: false,
  batch_id: null,
  output_path: null,
  output_size_bytes: null,
  progress_percent: 0,
  error_message: null,
  created_at: TEST_NOW,
  started_at: null,
  completed_at: null,
  ...overrides,
});

const createThumbnail = (videoId = 1) => ({
  id: 1,
  video_id: videoId,
  file_path: TEST_THUMBNAIL_PATH,
  file_size_bytes: 3,
  timestamp_seconds: 5,
  width: 320,
  height: 180,
  generated_at: TEST_NOW,
});

const createStoryboard = (videoId = 1) => ({
  id: 1,
  video_id: videoId,
  sprite_path: TEST_THUMBNAIL_PATH,
  vtt_path: "/tmp/conversor-video-test-storyboard.vtt",
  tile_width: 160,
  tile_height: 90,
  tile_count: 4,
  interval_seconds: 10,
  sprite_size_bytes: 3,
  generated_at: TEST_NOW,
});

const createRemoteJoinRequest = () => ({
  id: 1,
  sessionId: 1,
  requestingUserId: 1,
  requestingSessionId: "auth-session",
  status: "pending",
  requestedCode: "ABC123",
  canTrustDevice: true,
  remoteDeviceName: "Remote",
  remoteDeviceType: "mobile",
  remoteUserAgent: "integration-test",
  expiresAt: TEST_NOW,
  resolvedAt: null,
  createdAt: TEST_NOW,
  updatedAt: TEST_NOW,
});

const createRemoteSnapshot = () => ({
  sessionId: 1,
  status: "active",
  layoutMode: "grid",
  slots: [],
  slotOrder: [],
  activeSlotId: null,
  filters: {},
  updatedAt: TEST_NOW,
});

const createRemoteSession = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  ownerUserId: 1,
  displayClientId: "display-client",
  remoteClientId: "remote-client",
  pairingCode: "ABC123",
  pairingCodeExpiresAt: TEST_NOW,
  status: "waiting_for_remote",
  displayConnectedAt: TEST_NOW,
  displayLastSeenAt: TEST_NOW,
  remoteConnectedAt: null,
  remoteLastSeenAt: null,
  approvedAt: null,
  closedAt: null,
  closeReason: null,
  lastState: createRemoteSnapshot(),
  protocolVersion: 1,
  createdAt: TEST_NOW,
  updatedAt: TEST_NOW,
  pendingJoinRequest: createRemoteJoinRequest(),
  ...overrides,
});

const createTrustedDevice = () => ({
  id: 1,
  ownerUserId: 1,
  deviceName: "Remote",
  deviceType: "mobile",
  userAgent: "integration-test",
  trustedAt: TEST_NOW,
  lastSeenAt: TEST_NOW,
  revokedAt: null,
  createdAt: TEST_NOW,
  updatedAt: TEST_NOW,
});

const createDisplayDevice = () => ({
  id: 1,
  ownerUserId: 1,
  publicId: "display-public-id",
  deviceName: "Display",
  deviceType: "desktop",
  trustedAt: TEST_NOW,
  lastSeenAt: TEST_NOW,
  lastHeartbeatAt: TEST_NOW,
  revokedAt: null,
  createdAt: TEST_NOW,
  updatedAt: TEST_NOW,
});

const createFaceEmbedding = (creatorId = 1, id = 1) => ({
  id,
  creatorId,
  embedding: JSON.stringify([0.1, 0.2, 0.3]),
  sourceType: "manual_upload",
  sourceVideoId: null,
  sourceTimestampSeconds: null,
  detScore: 0.99,
  isPrimary: true,
  estimatedAge: 30,
  estimatedGender: "F",
  thumbnailPath: TEST_THUMBNAIL_PATH,
  createdAt: new Date(TEST_NOW),
  updatedAt: new Date(TEST_NOW),
});

const createFaceDetection = (videoId = 1) => ({
  id: 1,
  videoId,
  embedding: JSON.stringify([0.1, 0.2, 0.3]),
  timestampSeconds: 12,
  frameIndex: 3,
  bboxX1: 0.1,
  bboxY1: 0.1,
  bboxX2: 0.3,
  bboxY2: 0.4,
  detScore: 0.98,
  matchedCreatorId: null,
  matchConfidence: 0.92,
  matchStatus: "confirmed",
  estimatedAge: 30,
  estimatedGender: "F",
  createdAt: new Date(TEST_NOW),
  updatedAt: new Date(TEST_NOW),
});

export type TestApp = {
  app: AppInstance;
  database: TestDatabase;
  authCookie: string;
  userId: number;
  inject: AppInstance["inject"];
  authInject: (
    options: InjectOptions,
  ) => Promise<LightMyRequestResponse>;
  close: () => Promise<void>;
};

export type SeededVideo = {
  directoryId: number;
  videoId: number;
};

function installExternalServiceMocks(): void {
  mock.module("fluent-ffmpeg", () => ({
    default: {
      setFfmpegPath: mock(() => undefined),
      setFfprobePath: mock(() => undefined),
      ffprobe: mock((_path: string, callback: (error: Error | null, metadata: unknown) => void) =>
        callback(null, {
          streams: [
            {
              codec_type: "video",
              codec_name: "h264",
              width: 1920,
              height: 1080,
              r_frame_rate: "30/1",
            },
            {
              codec_type: "audio",
              codec_name: "aac",
              channels: 2,
              sample_rate: "48000",
            },
          ],
          format: {
            duration: "120",
            bit_rate: "8000000",
          },
        }),
      ),
    },
  }));

  mock.module("@/modules/directories/watcher.service", () => ({
    watcherService: {
      scanDirectory: mock(async () => undefined),
      startScan: mock(async (directoryId: number) => {
        const { directoryScansService } = await import(
          "@/modules/directories/directory-scans.service"
        );
        const run = await directoryScansService.create(directoryId);
        const result = {
          files_found: 0,
          files_added: 0,
          files_updated: 0,
          files_removed: 0,
          errors: [],
        };
        const completion = directoryScansService
          .complete(run.id, result)
          .then(() => result);
        return { run, completion };
      }),
      startWatching: mock(async () => undefined),
      stopWatching: mock(async () => undefined),
    },
  }));

  mock.module("@/modules/conversion/conversion.service", () => ({
    conversionService: {
      createJob: mock(async (input: { video_id: number; preset: string }) =>
        createConversionJob({ video_id: input.video_id, preset: input.preset }),
      ),
      bulkCreateJobs: mock(
        async (input: { videoIds: number[]; preset: string; batchId: string }) =>
          input.videoIds.map((videoId, index) =>
            createConversionJob({
              id: index + 1,
              video_id: videoId,
              preset: input.preset,
              batch_id: input.batchId,
            }),
          ),
      ),
      getQueue: mock(async () => [createConversionJob()]),
      listByVideoId: mock(async (videoId: number) => [
        createConversionJob({ video_id: videoId }),
      ]),
      getHistory: mock(async () => ({
        items: [
          {
            id: 1,
            conversion_job_id: 1,
            video_id: 1,
            source_video_deleted: false,
            source_file_path: "/tmp/source.mp4",
            source_file_name: "source.mp4",
            output_file_path: TEST_CONVERSION_OUTPUT_PATH,
            preset: "720p_h264",
            codec: "h264_vaapi",
            target_resolution: "720p",
            ffmpeg_command: "ffmpeg -i source.mp4 output.mkv",
            original_size_bytes: 1000,
            output_size_bytes: 600,
            size_delta_bytes: -400,
            size_change_percent: -40,
            conversion_duration_ms: 1000,
            duration_seconds: null,
            source_width: null,
            source_height: null,
            source_fps: null,
            source_codec: null,
            source_audio_codec: null,
            source_bitrate: null,
            output_width: null,
            output_height: null,
            output_fps: null,
            output_codec: null,
            output_audio_codec: null,
            output_bitrate: null,
            profile_version: null,
            planned_video_bitrate: null,
            planned_max_bitrate: null,
            planned_qp: null,
            effective_resolution: null,
            encoding_mode: null,
            encode_speed_ratio: null,
            started_at: TEST_NOW,
            completed_at: TEST_NOW,
            created_at: TEST_NOW,
          },
        ],
        total: 1,
        limit: 50,
        offset: 0,
      })),
      getHistoryOverview: mock(async () => ({
        total_conversions: 1,
        total_original_size_bytes: 1000,
        total_output_size_bytes: 600,
        total_size_delta_bytes: -400,
        total_saved_bytes: 400,
        total_increased_bytes: 0,
        saved_count: 1,
        increased_count: 0,
        unchanged_count: 0,
        avg_size_change_percent: -40,
        avg_conversion_duration_ms: 1000,
      })),
      findById: mock(async (id: number) =>
        createConversionJob({
          id,
          status: "completed",
          output_path: TEST_CONVERSION_OUTPUT_PATH,
          output_size_bytes: 3,
          progress_percent: 100,
          completed_at: TEST_NOW,
        }),
      ),
      cancel: mock(async (id: number) =>
        createConversionJob({ id, status: "cancelled" }),
      ),
      delete: mock(async () => undefined),
      getActiveConversions: mock(async () => [
        {
          id: 1,
          video_id: 1,
          video_title: "Seeded fixture video",
          preset: "720p_h264",
          status: "pending",
          progress_percent: 0,
          started_at: null,
          created_at: TEST_NOW,
        },
      ]),
      clearQueue: mock(async () => ({
        pendingCleared: 1,
        processingReset: 0,
      })),
      getQueueStatus: mock(async () => ({
        queueLength: 1,
        activeJobs: 0,
        isProcessing: false,
      })),
      getPresets: mock(() => [
        {
          id: "720p_h264",
          name: "720p H.264",
          description: "HD with H.264",
          targetWidth: 1280,
          codec: "h264_vaapi",
          qp: 26,
          audioBitrate: "96k",
          container: "mkv",
        },
      ]),
    },
  }));

  mock.module("@/modules/thumbnails/thumbnails.service", () => ({
    thumbnailsService: {
      generate: mock(async (videoId: number) => createThumbnail(videoId)),
      getByVideoId: mock(async (videoId: number) => [createThumbnail(videoId)]),
      findById: mock(async () => createThumbnail()),
      delete: mock(async () => undefined),
    },
  }));

  mock.module("@/modules/storyboards/storyboards.service", () => ({
    storyboardsService: {
      generate: mock(async (videoId: number) => createStoryboard(videoId)),
      delete: mock(async () => undefined),
      findByVideoId: mock(async (videoId: number) => createStoryboard(videoId)),
      findById: mock(async () => createStoryboard()),
      getVttContent: mock(async () => "WEBVTT\n\n00:00.000 --> 00:10.000\nsprite.jpg#xywh=0,0,160,90\n"),
      queueGenerate: mock(async () => undefined),
      getSpriteAsset: mock(async () => ({
        contentType: "image/jpeg",
        buffer: Buffer.from("jpg"),
      })),
    },
  }));

  mock.module("@/modules/backup/backup.service", () => ({
    backupService: {
      createBackup: mock(async () => ({
        filename: "backup-test.json",
        path: "/tmp/backup-test.json",
        sizeBytes: 2,
        createdAt: TEST_NOW,
      })),
      listBackups: mock(() => [
        {
          filename: "backup-test.json",
          path: "/tmp/backup-test.json",
          sizeBytes: 2,
          createdAt: TEST_NOW,
        },
      ]),
      exportToJson: mock(() => JSON.stringify({ videos: [] })),
      restoreBackup: mock(async () => undefined),
      deleteBackup: mock(() => undefined),
    },
  }));

  mock.module("@/modules/edits/edits.service", () => ({
    editsService: {
      create: mock(async (videoId: number, body: any) => ({
        id: 1,
        status: "queued",
        videoId,
        outputConfig: body.output,
      })),
      getById: mock(async (id: number) => ({
        id,
        videoId: 1,
        status: "completed",
        progress: 100,
        startedAt: TEST_NOW,
        completedAt: TEST_NOW,
        createdAt: TEST_NOW,
        outputVideoId: 2,
        outputConfig: {
          directory_id: 1,
          file_name: "edited.mkv",
          format: "mkv",
          video_codec: "av1",
          audio_codec: "opus",
        },
        timelineConfig: { segments: [{ start: 0, end: 10, speed: 1 }] },
        errorMessage: null,
      })),
      list: mock(async () => ({
        data: [
          {
            id: 1,
            videoId: 1,
            status: "completed",
            progress: 100,
            startedAt: TEST_NOW,
            completedAt: TEST_NOW,
            createdAt: TEST_NOW,
            outputVideoId: 2,
            outputConfig: {
              directory_id: 1,
              file_name: "edited.mkv",
              format: "mkv",
              video_codec: "av1",
              audio_codec: "opus",
            },
            timelineConfig: { segments: [{ start: 0, end: 10, speed: 1 }] },
            errorMessage: null,
          },
        ],
        pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
      })),
      recipeFor: mock((job: any) => ({
        source_video_id: job.videoId,
        output_defaults: {
          directory_id: job.outputConfig.directory_id,
          format: job.outputConfig.format,
          video_codec: job.outputConfig.video_codec,
          audio_codec: job.outputConfig.audio_codec,
        },
        timeline: job.timelineConfig,
      })),
      clone: mock(async (_id: number, body: any) => ({
        id: 2,
        status: "queued",
        videoId: 1,
        outputConfig: body.output,
      })),
      cancel: mock(async (id: number) => ({
        id,
        status: "cancelled",
      })),
    },
  }));

  mock.module("@/modules/multiplayer-remote/multiplayer-remote.service", () => ({
    multiplayerRemoteService: {
      registerDisplayDevice: mock(async () => ({
        displayDevice: createDisplayDevice(),
        deviceSecret: "x".repeat(32),
      })),
      createSession: mock(async () => createRemoteSession()),
      getSession: mock(async () => createRemoteSession()),
      closeSession: mock(async () => undefined),
      pair: mock(async () => ({
        sessionId: 1,
        joinRequest: createRemoteJoinRequest(),
      })),
      discoverTrustedSessions: mock(async () => ({
        trustedDevice: createTrustedDevice(),
        sessions: [
          {
            id: 1,
            ownerUserId: 1,
            displayClientId: "display-client",
            status: "waiting_for_remote",
            displayConnectedAt: TEST_NOW,
            displayLastSeenAt: TEST_NOW,
            lastState: createRemoteSnapshot(),
            protocolVersion: 1,
            createdAt: TEST_NOW,
            updatedAt: TEST_NOW,
            displayDevice: createDisplayDevice(),
          },
        ],
      })),
      connectTrustedDevice: mock(async () => ({
        session: createRemoteSession({ status: "active" }),
        trustedDevice: createTrustedDevice(),
      })),
      getPendingJoinRequestForDisplay: mock(async () =>
        createRemoteJoinRequest(),
      ),
      approveJoinRequest: mock(async () =>
        createRemoteSession({ status: "active" }),
      ),
      rejectJoinRequest: mock(async () =>
        createRemoteSession({ status: "waiting_for_remote" }),
      ),
    },
  }));

  mock.module("@/modules/multiplayer-remote/multiplayer-remote.websocket", () => ({
    multiplayerRemoteWebSocketService: {
      register: mock(() => undefined),
      closeAll: mock(() => undefined),
      notifySessionClosed: mock(() => undefined),
      notifyJoinRequested: mock(() => undefined),
      notifyJoinApproved: mock(() => undefined),
      notifyJoinRejected: mock(() => undefined),
    },
  }));

  mock.module("@/modules/events/events.service", () => ({
    eventsService: {
      addAuthenticatedClient: mock(({ response }: { response: NodeJS.WritableStream }) => {
        response.write?.("event: ready\ndata: {}\n\n");
        response.end?.();
      }),
      closeAll: mock(() => undefined),
    },
  }));

  mock.module("@/modules/face-recognition/face-recognition.client", () => ({
    getFaceRecognitionClient: mock(() => ({
      healthCheck: mock(async () => ({
        status: "ok",
        version: "test",
      })),
      detectFacesFromFile: mock(async () => ({
        faces: [
          {
            bbox: [0.1, 0.1, 0.3, 0.4],
            det_score: 0.98,
            embedding: [0.1, 0.2, 0.3],
            age: 30,
            gender: "F",
          },
        ],
      })),
    })),
  }));

  mock.module("@/modules/face-recognition/face-images.service", () => ({
    getFaceImagesService: mock(() => ({
      getOrGenerateByDetectionId: mock(async () => ({
        id: 1,
        detectionId: 1,
        filePath: TEST_THUMBNAIL_PATH,
        createdAt: new Date(TEST_NOW),
      })),
    })),
  }));

  mock.module("@/modules/face-recognition/face-recognition.service", () => ({
    getFaceRecognitionService: mock(() => ({
      addCreatorEmbedding: mock(async (input: { creatorId: number }) =>
        createFaceEmbedding(input.creatorId),
      ),
      getCreatorEmbeddings: mock(async (creatorId: number) => [
        createFaceEmbedding(creatorId),
      ]),
      setPrimaryEmbedding: mock(async () => undefined),
      deleteCreatorEmbedding: mock(async () => undefined),
      getVideoFaceDetections: mock(async (videoId: number) => [
        createFaceDetection(videoId),
      ]),
      processFacesOnly: mock(async () => undefined),
      confirmFaceMatch: mock(async () => undefined),
      rejectFaceMatch: mock(async () => undefined),
      findVideosWithCreator: mock(async (creatorId: number) => [
        {
          video_id: 1,
          creator_id: creatorId,
          detection_count: 1,
          max_confidence: 0.92,
        },
      ]),
      findSimilarCreators: mock(async () => [
        {
          creator_id: 1,
          creator_name: "Face Match Creator",
          similarity: 0.94,
          reference_embedding_id: 1,
        },
      ]),
      getFaceExtractionJob: mock(async (videoId: number) => ({
        id: 1,
        videoId,
        status: "completed",
        progress: 100,
        errorMessage: null,
        createdAt: new Date(TEST_NOW),
        updatedAt: new Date(TEST_NOW),
      })),
      clearQueue: mock(async () => undefined),
    })),
  }));

  mock.module("@/utils/telemetry", () => ({
    isTelemetryEnabled: mock(() => false),
    captureTelemetryEvent: mock(() => undefined),
    captureTelemetryException: mock(() => undefined),
    captureTelemetryExceptionImmediate: mock(async () => undefined),
    captureTelemetryLog: mock(() => undefined),
    flushTelemetry: mock(async () => undefined),
    getTelemetryDistinctId: mock(() => "test-user"),
    sanitizeTelemetryProperties: mock(
      (properties: Record<string, unknown>) => properties,
    ),
    sanitizeTelemetryUrl: mock((url: string) => url),
    shouldCaptureLog: mock(() => false),
    shouldTrackRequestMetrics: mock(() => false),
    shutdownTelemetry: mock(async () => undefined),
  }));
}

function getCookieHeader(response: LightMyRequestResponse): string {
  const setCookie = response.headers["set-cookie"];
  const cookies = Array.isArray(setCookie)
    ? setCookie
    : setCookie
      ? [setCookie]
      : [];

  return cookies.map((cookie) => cookie.split(";")[0]).join("; ");
}

export async function createTestApp(): Promise<TestApp> {
  const database = await startTestDatabase();

  try {
    await Promise.all([
      writeFile(TEST_THUMBNAIL_PATH, Buffer.from("jpg")),
      writeFile(TEST_CONVERSION_OUTPUT_PATH, Buffer.from("mkv")),
    ]);
    applyTestDatabaseEnv(database);
    installExternalServiceMocks();
    await migrateTestDatabase();

    const { buildServer } = await import("@/server");
    const app = await buildServer();
    await app.ready();

    const email = `integration-${Date.now()}@example.test`;
    const password = "integration-password";
    const registerResponse = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        email,
        password,
        name: "Integration User",
      },
    });

    if (registerResponse.statusCode !== 201) {
      throw new Error(
        `Could not create integration user: ${registerResponse.statusCode} ${registerResponse.body}`,
      );
    }

    const loginResponse = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        email,
        password,
      },
    });

    if (loginResponse.statusCode !== 200) {
      throw new Error(
        `Could not authenticate integration user: ${loginResponse.statusCode} ${loginResponse.body}`,
      );
    }

    const authCookie = getCookieHeader(loginResponse);
    const body = loginResponse.json() as { data: { id: number } };

    return {
      app,
      database,
      authCookie,
      userId: body.data.id,
      inject: app.inject.bind(app),
      authInject: (options) =>
        app.inject({
          ...options,
          headers: {
            ...(options.headers ?? {}),
            cookie: authCookie,
          },
        }),
      close: async () => {
        await app.close();
        await database.stop();
      },
    };
  } catch (error) {
    await database.stop();
    throw error;
  }
}

export async function seedVideoFixture(
  fileName = `fixture-${Date.now()}.mp4`,
): Promise<SeededVideo> {
  const { db } = await import("@/config/drizzle");
  const { watchedDirectoriesTable, videosTable } = await import(
    "@/database/schema"
  );

  const [directory] = await db
    .insert(watchedDirectoriesTable)
    .values({
      path: `/tmp/conversor-video-fixture-${Date.now()}-${Math.random()
        .toString(16)
        .slice(2)}`,
      autoScan: false,
      scanIntervalMinutes: 30,
    })
    .returning({ id: watchedDirectoriesTable.id });

  if (!directory) {
    throw new Error("Failed to seed fixture directory");
  }

  const [video] = await db
    .insert(videosTable)
    .values({
      directoryId: directory.id,
      filePath: `/tmp/${fileName}`,
      fileName,
      fileSizeBytes: 4096,
      durationSeconds: 120,
      title: "Seeded fixture video",
      isAvailable: true,
    })
    .returning({ id: videosTable.id });

  if (!video) {
    throw new Error("Failed to seed fixture video");
  }

  return {
    directoryId: directory.id,
    videoId: video.id,
  };
}
