import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import type {
  PerceptualDuplicatesJobView,
  PerceptualDuplicatesServiceContract,
} from "@/modules/perceptual-duplicates/perceptual-duplicates.types";

process.env.POSTGRES_USER ||= "perceptual-duplicates-routes-test";
process.env.POSTGRES_PASSWORD ||= "perceptual-duplicates-routes-test";
process.env.SESSION_SECRET ||=
  "perceptual-duplicates-session-secret-at-least-32-characters";
process.env.DEMO_MODE = "false";

mock.module("@/modules/auth/auth.middleware", () => ({
  authenticateUser: async (request: any) => {
    if (request.headers.authorization !== "Bearer test") {
      const error = new Error("Unauthorized") as Error & { statusCode: number };
      error.statusCode = 401;
      throw error;
    }
    request.user = { id: 7 };
  },
}));

const now = new Date("2026-09-21T12:00:00.000Z");
const result = {
  version: 1 as const,
  revision: "video-copies-v1",
  videos: [
    { id: 12, frame_count: 120, duration_seconds: 60 },
    { id: 44, frame_count: 300, duration_seconds: 1800 },
  ],
  matches: [
    {
      video_a: 12,
      video_b: 44,
      status: "verified" as const,
      segments: [
        {
          a_start: 0,
          a_end: 60,
          b_start: 1200,
          b_end: 1260,
          speed: 1,
          matched_frames: 60,
          spatial_inliers: 157,
          status: "verified" as const,
          motion: 0.8,
          timing_error_seconds: 0.04,
          temporal_motion_similarity: 0.92,
          temporal_motion_energy: 0.71,
        },
      ],
      coverage_a: 1,
      coverage_b: 60 / 1800,
    },
  ],
  runtime: {
    inference_provider: "MIGraphXExecutionProvider" as const,
    onnxruntime: "1.25.0",
    precision: "fp32" as const,
    decode: "vaapi" as const,
    model_sha256: "a".repeat(64),
    initialization_seconds: 1.2,
    elapsed_seconds: 3.5,
    sample_rate: 1,
    verification_rate: 5,
    candidate_limit_per_pair: 8,
    candidate_limited_pairs: 0,
    cache_bytes: 4096,
  },
};
const job: PerceptualDuplicatesJobView = {
  id: 19,
  userId: 7,
  videoIds: [12, 44],
  status: "completed",
  phase: "completed",
  completedUnits: 2,
  totalUnits: 2,
  result,
  error: null,
  retryCount: 0,
  createdAt: now,
  updatedAt: now,
  startedAt: now,
  completedAt: now,
  cancelledAt: null,
};

const start = mock(async () => ({ job, reused: false }));
const get = mock(async () => job);
const cancel = mock(async () => ({
  ...job,
  status: "cancelled" as const,
  phase: "cancelled" as const,
  result: null,
  cancelledAt: now,
}));

let app: ReturnType<typeof Fastify>;

beforeAll(async () => {
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const { perceptualDuplicatesRoutes } =
    await import("@/modules/perceptual-duplicates/perceptual-duplicates.routes");
  await perceptualDuplicatesRoutes(app, {
    service: { start, get, cancel } as PerceptualDuplicatesServiceContract,
  });
  await app.ready();
});

afterAll(async () => app.close());

describe("perceptual duplicate routes", () => {
  it("requires authentication for start, inspect, and cancellation", async () => {
    const responses = await Promise.all([
      app.inject({
        method: "POST",
        url: "/perceptual-duplicates/jobs",
        payload: { video_ids: [12, 44] },
      }),
      app.inject({ method: "GET", url: "/perceptual-duplicates/jobs/19" }),
      app.inject({ method: "DELETE", url: "/perceptual-duplicates/jobs/19" }),
    ]);
    expect(responses.map(({ statusCode }) => statusCode)).toEqual([
      401, 401, 401,
    ]);
  });

  it("queues an owner-scoped batch and returns a canonical polling location", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/perceptual-duplicates/jobs",
      headers: { authorization: "Bearer test" },
      payload: { video_ids: [44, 12] },
    });

    expect(response.statusCode).toBe(202);
    expect(response.headers.location).toBe(
      "/api/perceptual-duplicates/jobs/19"
    );
    expect(start).toHaveBeenCalledWith({ userId: 7, videoIds: [44, 12] });
    expect(response.json()).toMatchObject({
      success: true,
      data: {
        reused: false,
        job: {
          id: 19,
          video_ids: [12, 44],
          result: {
            revision: "video-copies-v1",
            matches: [{ video_a: 12, video_b: 44, status: "verified" }],
          },
        },
      },
    });
    expect(JSON.stringify(response.json())).not.toContain("path");
  });

  it("scopes polling and cancellation to the authenticated owner", async () => {
    const headers = { authorization: "Bearer test" };
    const inspected = await app.inject({
      method: "GET",
      url: "/perceptual-duplicates/jobs/19",
      headers,
    });
    const cancelled = await app.inject({
      method: "DELETE",
      url: "/perceptual-duplicates/jobs/19",
      headers,
    });

    expect(inspected.statusCode).toBe(200);
    expect(cancelled.statusCode).toBe(200);
    expect(get).toHaveBeenCalledWith(19, 7);
    expect(cancel).toHaveBeenCalledWith(19, 7);
  });

  it("rejects duplicate, undersized, and oversized selections", async () => {
    const headers = { authorization: "Bearer test" };
    const responses = await Promise.all([
      app.inject({
        method: "POST",
        url: "/perceptual-duplicates/jobs",
        headers,
        payload: { video_ids: [12, 12] },
      }),
      app.inject({
        method: "POST",
        url: "/perceptual-duplicates/jobs",
        headers,
        payload: { video_ids: [12] },
      }),
      app.inject({
        method: "POST",
        url: "/perceptual-duplicates/jobs",
        headers,
        payload: {
          video_ids: Array.from({ length: 13 }, (_, index) => index + 1),
        },
      }),
    ]);
    expect(responses.map(({ statusCode }) => statusCode)).toEqual([
      400, 400, 400,
    ]);
  });

  it("returns a stable unavailable contract before a job is queued", async () => {
    start.mockRejectedValueOnce(
      Object.assign(new Error("private setup detail"), {
        code: "PERCEPTUAL_DUPLICATES_UNAVAILABLE",
      })
    );
    const response = await app.inject({
      method: "POST",
      url: "/perceptual-duplicates/jobs",
      headers: { authorization: "Bearer test" },
      payload: { video_ids: [12, 44] },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      success: false,
      error: {
        code: "PERCEPTUAL_DUPLICATES_UNAVAILABLE",
        message: "Perceptual duplicate comparison is unavailable",
        statusCode: 503,
      },
    });
    expect(response.body).not.toContain("private setup detail");
  });

  it("returns the stable readiness error before a manual job is queued", async () => {
    start.mockRejectedValueOnce(
      Object.assign(new Error("private validation detail"), {
        code: "COPY_ENGINE_NOT_READY",
        statusCode: 503,
      })
    );
    const response = await app.inject({
      method: "POST",
      url: "/perceptual-duplicates/jobs",
      headers: { authorization: "Bearer test" },
      payload: { video_ids: [12, 44] },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      success: false,
      error: {
        code: "COPY_ENGINE_NOT_READY",
        message:
          "Perceptual duplicate analysis is disabled by server configuration; face and timeline jobs are available.",
        statusCode: 503,
      },
    });
    expect(response.body).not.toContain("private validation detail");
  });
});
