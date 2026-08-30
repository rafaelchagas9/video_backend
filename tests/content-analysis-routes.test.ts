import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import type {
  ContentAnalysisRun,
  ContentAnalysisService,
} from "@/modules/content-analysis";

process.env.POSTGRES_USER ||= "content-analysis-routes-test";
process.env.POSTGRES_PASSWORD ||= "content-analysis-routes-test";
process.env.SESSION_SECRET ||=
  "content-analysis-routes-session-secret-at-least-32-characters";
process.env.DEMO_MODE = "false";

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

const now = new Date("2026-08-28T12:00:00.000Z");
const run: ContentAnalysisRun = {
  id: 9,
  durableJobId: 19,
  videoId: 42,
  userId: 7,
  kind: "nudity",
  profile: "balanced",
  requestedCategories: ["BUTTOCKS_EXPOSED"],
  status: "queued",
  phase: "queued",
  scannedSeconds: 0,
  sourceDurationSeconds: 10_800,
  sampledFrames: 0,
  positiveFrames: 0,
  sourceFingerprint: "partial-sha256-v1:fixture",
  analyzerRevision: "nudity-processor-v1",
  modelRevision: "nudenet-3.4.2/640m@sha256:fixture",
  taxonomyRevision: "nudenet-selected-11-v1",
  configRevision: "nudity-processor-v1",
  idempotencyKey: null,
  requestDigest: "request:fixture",
  semanticGenerationKey: "semantic:fixture",
  resultEventCount: 0,
  resultBookmarkCount: 0,
  errorCode: null,
  errorMessage: null,
  retryCount: 0,
  isPublished: false,
  publishedAt: null,
  startedAt: null,
  completedAt: null,
  cancelledAt: null,
  createdAt: now,
  updatedAt: now,
};

const start = mock(async () => ({ run, reused: false }));
const get = mock(async () => run);
const cancel = mock(async () => ({
  ...run,
  status: "cancelled" as const,
  phase: "cancelled" as const,
  cancelledAt: now,
  completedAt: now,
}));

let app: ReturnType<typeof Fastify>;

beforeAll(async () => {
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const { contentAnalysisRoutes } =
    await import("@/modules/content-analysis/content-analysis.routes");
  await contentAnalysisRoutes(app, {
    service: { start, get, cancel } as unknown as ContentAnalysisService,
  });
  await app.ready();
});

afterAll(async () => app.close());

describe("content analysis routes", () => {
  it("requires authentication for start, inspect, and cancellation", async () => {
    const responses = await Promise.all([
      app.inject({
        method: "POST",
        url: "/videos/42/analyses/nudity",
        payload: {},
      }),
      app.inject({ method: "GET", url: "/content-analysis/jobs/9" }),
      app.inject({ method: "DELETE", url: "/content-analysis/jobs/9" }),
    ]);
    expect(responses.map((response) => response.statusCode)).toEqual([
      401, 401, 401,
    ]);
  });

  it("accepts a run with a canonical polling Location and owner-scoped input", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/videos/42/analyses/nudity",
      headers: {
        authorization: "Bearer test",
        "idempotency-key": "owner-request-1",
      },
      payload: {
        profile: "balanced",
        categories: ["BUTTOCKS_EXPOSED"],
      },
    });

    expect(response.statusCode).toBe(202);
    expect(response.headers.location).toBe("/api/content-analysis/jobs/9");
    expect(start).toHaveBeenCalledWith({
      videoId: 42,
      userId: 7,
      profile: "balanced",
      categories: ["BUTTOCKS_EXPOSED"],
      force: false,
      idempotencyKey: "owner-request-1",
    });
    expect(response.json()).toMatchObject({
      success: true,
      data: {
        reused: false,
        job: {
          id: 9,
          video_id: 42,
          requested_categories: ["BUTTOCKS_EXPOSED"],
          progress: { scanned_seconds: 0, source_duration_seconds: 10_800 },
        },
      },
    });
  });

  it("accepts the fast keyframe sampling profile", async () => {
    start.mockResolvedValueOnce({
      run: { ...run, profile: "fast" },
      reused: false,
    });
    const response = await app.inject({
      method: "POST",
      url: "/videos/42/analyses/nudity",
      headers: { authorization: "Bearer test" },
      payload: {
        profile: "fast",
        categories: ["BUTTOCKS_EXPOSED"],
      },
    });

    expect(response.statusCode).toBe(202);
    expect(start).toHaveBeenLastCalledWith(
      expect.objectContaining({ profile: "fast" })
    );
    expect(response.json().data.job.profile).toBe("fast");
  });

  it("returns and conditionally cancels only through the authenticated owner", async () => {
    const headers = { authorization: "Bearer test" };
    const inspected = await app.inject({
      method: "GET",
      url: "/content-analysis/jobs/9",
      headers,
    });
    const cancelled = await app.inject({
      method: "DELETE",
      url: "/content-analysis/jobs/9",
      headers,
    });

    expect(inspected.statusCode).toBe(200);
    expect(inspected.json().data.status).toBe("queued");
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().data.status).toBe("cancelled");
    expect(get).toHaveBeenCalledWith(9, 7);
    expect(cancel).toHaveBeenCalledWith(9, 7);
  });

  it("rejects duplicate categories and overlong idempotency keys before service work", async () => {
    const headers = { authorization: "Bearer test" };
    const duplicate = await app.inject({
      method: "POST",
      url: "/videos/42/analyses/nudity",
      headers,
      payload: {
        categories: ["BUTTOCKS_EXPOSED", "BUTTOCKS_EXPOSED"],
      },
    });
    const key = await app.inject({
      method: "POST",
      url: "/videos/42/analyses/nudity",
      headers: { ...headers, "idempotency-key": "x".repeat(256) },
      payload: {},
    });

    expect(duplicate.statusCode).toBe(400);
    expect(key.statusCode).toBe(400);
  });
});
