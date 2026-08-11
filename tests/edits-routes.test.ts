import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import swagger from "@fastify/swagger";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import type { EditJob } from "@/modules/edits/edits.types";

const TEST_NOW = "2026-08-11T12:00:00.000Z";

const completedJob: EditJob = {
  id: 7,
  videoId: 3,
  status: "completed" as const,
  progress: 100,
  outputConfig: {
    directory_id: 2,
    file_name: "finished.mkv",
    format: "mkv" as const,
    video_codec: "av1" as const,
    audio_codec: "opus" as const,
  },
  timelineConfig: { segments: [{ start: 0, end: 5, speed: 1 }] },
  outputPath: "/library/finished.mkv",
  outputVideoId: 99,
  errorMessage: null,
  startedAt: TEST_NOW,
  completedAt: TEST_NOW,
  createdAt: TEST_NOW,
};

const editsServiceMock = {
  create: mock(
    async (
      videoId: number,
      input: { output: typeof completedJob.outputConfig }
    ) => ({
      ...completedJob,
      id: 8,
      videoId,
      status: "queued" as const,
      progress: 0,
      outputConfig: { ...input.output, file_name: "new-edit.mkv" },
      outputVideoId: null,
      startedAt: null,
      completedAt: null,
    })
  ),
  list: mock(async () => ({
    data: [completedJob],
    pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
  })),
  getById: mock(async () => completedJob),
  cancel: mock(async () => ({ ...completedJob, status: "cancelled" as const })),
};

mock.module("@/config/env", () => ({ env: { DEMO_MODE: false } }));
mock.module("@/modules/auth/auth.middleware", () => ({
  authenticateUser: mock(
    async (request: { headers: Record<string, unknown> }) => {
      if (request.headers["x-test-auth"] !== "allowed") {
        throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
      }
    }
  ),
}));
mock.module("@/modules/videos/videos.service", () => ({
  videosService: {
    findById: mock(async (id: number) => ({
      id,
      title: "Fixture video",
      file_path: "/fixture/source.mkv",
      duration_seconds: 120,
      fps: 30,
      width: 1920,
      height: 1080,
      bitrate: 8_000_000,
      audio_codec: "aac",
    })),
  },
}));
mock.module("@/modules/storyboards/storyboards.service", () => ({
  storyboardsService: { findByVideoId: mock(async () => ({ id: 1 })) },
}));
mock.module("@/modules/edits/edits.service", () => ({
  editsService: editsServiceMock,
}));
mock.module("@/modules/edits/edits.demo.service", () => ({
  editsDemoService: {},
}));
mock.module("fluent-ffmpeg", () => ({
  default: {
    ffprobe: mock(
      (
        _path: string,
        callback: (
          error: Error | null,
          metadata: {
            streams: Array<{
              codec_type: string;
              codec_name: string;
              channels: number;
              sample_rate: string;
            }>;
          }
        ) => void
      ) =>
        callback(null, {
          streams: [
            {
              codec_type: "audio",
              codec_name: "aac",
              channels: 2,
              sample_rate: "48000",
            },
          ],
        })
    ),
  },
}));

describe("edit HTTP contract", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(swagger, {
      openapi: { info: { title: "Editing contract", version: "1" } },
      transform: jsonSchemaTransform,
    });
    app.setErrorHandler((error, _request, reply) => {
      const routeError = error as {
        message?: string;
        statusCode?: number;
        validation?: unknown;
      };
      const statusCode =
        typeof routeError.statusCode === "number"
          ? routeError.statusCode
          : routeError.validation
            ? 400
            : 500;
      return reply.status(statusCode).send({
        success: false,
        error: { message: routeError.message ?? "Unknown error", statusCode },
      });
    });

    const { editsRoutes, videoEditsRoutes } =
      await import("@/modules/edits/edits.routes");
    await app.register(videoEditsRoutes, { prefix: "/api/videos" });
    await app.register(editsRoutes, { prefix: "/api/edits" });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  const authHeaders = { "x-test-auth": "allowed" };

  it("returns metadata with honest audio and editing capabilities", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/videos/3/editing-metadata",
      headers: authHeaders,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      audio: { present: true, codec: "aac", channels: 2, sample_rate: 48000 },
      capabilities: {
        timeline: {
          single_source_only: true,
          trim: true,
          reorder: true,
          segment_effects: {
            transform: {
              crop: "normalized",
              rotate: [0, 90, 180, 270],
            },
            audio: {
              mute: true,
              volume: { min: 0, max: 4 },
              fades: true,
            },
          },
        },
        transform: { crop: "normalized", rotate: [0, 90, 180, 270] },
        output: {
          formats: ["mkv"],
          video_codecs: ["av1"],
          audio_codecs: ["opus", "aac"],
        },
      },
    });
  });

  it("creates with 202 and a canonical polling Location", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/videos/3/edits",
      headers: authHeaders,
      payload: {
        output: { directory_id: 2, file_name: "new-edit" },
        timeline: {
          segments: [
            {
              start: 0,
              end: 5,
              transform: {
                crop: { x: 0.1, y: 0, width: 0.8, height: 1 },
                rotate: 90,
              },
              audio: {
                volume: 0.75,
                fade_in_seconds: 0.25,
                fade_out_seconds: 0.5,
              },
            },
          ],
        },
      },
    });

    expect(response.statusCode).toBe(202);
    expect(response.headers.location).toBe("/api/edits/jobs/8");
    expect(response.json().data).toMatchObject({
      job_id: 8,
      video_id: 3,
      status: "queued",
      output: { file_name: "new-edit.mkv" },
    });
    expect(editsServiceMock.create).toHaveBeenLastCalledWith(
      3,
      expect.objectContaining({
        timeline: {
          segments: [
            expect.objectContaining({
              speed: 1,
              transform: expect.objectContaining({ rotate: 90 }),
              audio: expect.objectContaining({
                volume: 0.75,
                fade_in_seconds: 0.25,
                fade_out_seconds: 0.5,
              }),
            }),
          ],
        },
      })
    );
  });

  it("lists jobs for reload recovery and exposes canonical output URLs", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/edits/jobs?page=1&limit=20&video_id=3&status=completed",
      headers: authHeaders,
    });

    expect(response.statusCode).toBe(200);
    expect(editsServiceMock.list).toHaveBeenLastCalledWith({
      page: 1,
      limit: 20,
      videoId: 3,
      status: "completed",
    });
    expect(response.json()).toMatchObject({
      data: [
        {
          job_id: 7,
          video_id: 3,
          output: {
            video_id: 99,
            stream_url: "/api/videos/99/stream",
          },
        },
      ],
      pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
    });

    const status = await app.inject({
      method: "GET",
      url: "/api/edits/jobs/7",
      headers: authHeaders,
    });
    expect(status.json().data.output.stream_url).toBe("/api/videos/99/stream");
  });

  it("does not expose internal render errors or local paths", async () => {
    editsServiceMock.getById.mockResolvedValueOnce({
      ...completedJob,
      status: "failed" as const,
      outputPath: null,
      outputVideoId: null,
      errorMessage: "ffmpeg failed while reading /private/library/source.mkv",
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/edits/jobs/7",
      headers: authHeaders,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.error).toEqual({
      code: "RENDER_FAILED",
      message: "Video rendering failed",
    });
    expect(response.body).not.toContain("/private/library");
  });

  it("returns normal validation and authentication errors", async () => {
    const unauthorized = await app.inject({
      method: "GET",
      url: "/api/edits/jobs/7",
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.json() as unknown).toEqual({
      success: false,
      error: { message: "Unauthorized", statusCode: 401 },
    });

    const invalid = await app.inject({
      method: "POST",
      url: "/api/videos/3/edits",
      headers: authHeaders,
      payload: {
        output: { directory_id: 2, file_name: "../escape.mkv" },
        timeline: { segments: [{ start: 5, end: 1 }] },
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({
      success: false,
      error: { statusCode: 400 },
    });
  });

  it("documents success, recovery, and standard error responses", () => {
    const paths = app.swagger().paths as Record<
      string,
      Record<string, { responses?: Record<string, unknown> }>
    >;

    expect(paths["/api/videos/{id}/edits"]?.post?.responses).toEqual(
      expect.objectContaining({
        "202": expect.anything(),
        "400": expect.anything(),
        "401": expect.anything(),
        "404": expect.anything(),
        "409": expect.anything(),
        "500": expect.anything(),
      })
    );
    expect(paths["/api/edits/jobs"]?.get?.responses).toEqual(
      expect.objectContaining({
        "200": expect.anything(),
        "400": expect.anything(),
        "401": expect.anything(),
        "500": expect.anything(),
      })
    );
    expect(paths["/api/edits/jobs/{id}"]?.get?.responses).toEqual(
      expect.objectContaining({
        "200": expect.anything(),
        "400": expect.anything(),
        "401": expect.anything(),
        "404": expect.anything(),
        "500": expect.anything(),
      })
    );
  });
});
