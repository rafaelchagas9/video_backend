import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import type {
  LibrarySyncRun,
  LibrarySyncServiceContract,
} from "@/modules/library-sync/library-sync.types";

process.env.POSTGRES_USER ||= "library-sync-routes-test";
process.env.POSTGRES_PASSWORD ||= "library-sync-routes-test";
process.env.SESSION_SECRET ||=
  "library-sync-session-secret-at-least-32-characters";
process.env.DEMO_MODE = "false";
mock.module("@/modules/auth/auth.middleware", () => ({
  authenticateUser: async (request: any) => {
    if (request.headers.authorization !== "Bearer test")
      throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
    request.user = { id: 7 };
  },
}));
const now = new Date("2026-09-21T12:00:00.000Z");
const progress = {
  total: 2,
  processed: 1,
  completed: 1,
  failed: 0,
  skipped: 0,
  pending: 1,
  current: { task: "perceptual" as const, videoId: 12 },
  byTask: {
    perceptual: {
      total: 2,
      processed: 1,
      completed: 1,
      failed: 0,
      skipped: 0,
      pending: 1,
    },
    faces: {
      total: 0,
      processed: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
      pending: 0,
    },
    storyboards: {
      total: 0,
      processed: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
      pending: 0,
    },
    previews: {
      total: 0,
      processed: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
      pending: 0,
    },
  },
};
const run: LibrarySyncRun = {
  id: 31,
  generation: "library-sync-v2:test-catalog",
  tasks: ["perceptual"],
  trigger: "manual",
  status: "running",
  phase: "executing",
  progress,
  recentItems: [
    {
      task: "perceptual",
      videoId: 11,
      status: "completed",
      result: { compared_videos: 10, match_count: 1, truncated_matches: false },
      error: null,
    },
  ],
  error: null,
  retryCount: 0,
  createdAt: now,
  updatedAt: now,
  startedAt: now,
  completedAt: null,
  cancelledAt: null,
};
const overview = mock(async () => ({
  generation: "library-sync-v2:test-catalog",
  capabilities: {
    perceptual: { enabled: true, code: null, reason: null },
  },
  settings: { autoPerceptual: true },
  counts: {
    totalVideos: 12,
    tasks: {
      perceptual: { pending: 2, completed: 10 },
      faces: { pending: 5, completed: 7 },
      storyboards: { pending: 3, completed: 9 },
      previews: { pending: 12, completed: 0 },
    },
  },
  activeRun: run,
  recentRuns: [run],
}));
const startRun = mock(async () => ({ run, reused: false }));
const getRun = mock(async () => run);
const cancelRun = mock(async () => ({
  ...run,
  status: "cancelled" as const,
  phase: "cancelled" as const,
  cancelledAt: now,
}));
const updateSettings = mock(
  async ({ autoPerceptual }: { autoPerceptual: boolean }) => ({
    autoPerceptual,
  })
);
const perceptualResults = mock(async () => ({
  items: [],
  assessment_revision: "relevance-v1",
  diagnostics: {
    candidate_limited_pairs: 0,
    truncated_videos: 0,
    suppressed_matches: 0,
  },
  total: 0,
  limit: 20,
  offset: 0,
}));
let app: ReturnType<typeof Fastify>;
beforeAll(async () => {
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const { librarySyncRoutes } =
    await import("@/modules/library-sync/library-sync.routes");
  await librarySyncRoutes(app, {
    service: {
      overview,
      startRun,
      getRun,
      cancelRun,
      updateSettings,
      perceptualResults,
    } as LibrarySyncServiceContract,
  });
  await app.ready();
});
afterAll(async () => app.close());
const headers = { authorization: "Bearer test" };
describe("library sync routes", () => {
  it("requires authentication on every operation", async () => {
    const responses = await Promise.all([
      app.inject({ method: "GET", url: "/library-sync" }),
      app.inject({
        method: "POST",
        url: "/library-sync/runs",
        payload: { tasks: ["faces"] },
      }),
      app.inject({ method: "GET", url: "/library-sync/runs/31" }),
      app.inject({ method: "DELETE", url: "/library-sync/runs/31" }),
      app.inject({
        method: "PATCH",
        url: "/library-sync/settings",
        payload: { auto_perceptual: false },
      }),
      app.inject({ method: "GET", url: "/library-sync/perceptual-results" }),
    ]);
    expect(responses.map((r) => r.statusCode)).toEqual([
      401, 401, 401, 401, 401, 401,
    ]);
  });
  it("returns typed overview progress without private paths", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/library-sync",
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      data: {
        generation: "library-sync-v2:test-catalog",
        capabilities: {
          perceptual: { enabled: true, code: null, reason: null },
        },
        settings: { auto_perceptual: true },
        counts: { total_videos: 12 },
        active_run: {
          id: 31,
          progress: { current: { task: "perceptual", video_id: 12 } },
          recent_items: [{ video_id: 11, result: { match_count: 1 } }],
        },
      },
    });
    expect(response.body).not.toContain("filePath");
  });
  it("queues, polls, and cancels a selected run", async () => {
    const started = await app.inject({
      method: "POST",
      url: "/library-sync/runs",
      headers,
      payload: { tasks: ["storyboards", "faces"] },
    });
    expect(started.statusCode).toBe(202);
    expect(started.headers.location).toBe("/api/library-sync/runs/31");
    expect(startRun).toHaveBeenCalledWith({
      tasks: ["storyboards", "faces"],
      userId: 7,
    });
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/library-sync/runs/31",
          headers,
        })
      ).statusCode
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: "/library-sync/runs/31",
          headers,
        })
      ).json().data.status
    ).toBe("cancelled");
  });
  it("validates unique task selection and settings", async () => {
    const duplicate = await app.inject({
      method: "POST",
      url: "/library-sync/runs",
      headers,
      payload: { tasks: ["faces", "faces"] },
    });
    const empty = await app.inject({
      method: "POST",
      url: "/library-sync/runs",
      headers,
      payload: { tasks: [] },
    });
    const badSetting = await app.inject({
      method: "PATCH",
      url: "/library-sync/settings",
      headers,
      payload: { auto_perceptual: "yes" },
    });
    expect([
      duplicate.statusCode,
      empty.statusCode,
      badSetting.statusCode,
    ]).toEqual([400, 400, 400]);
  });
  it("updates auto mode and paginates perceptual results", async () => {
    const setting = await app.inject({
      method: "PATCH",
      url: "/library-sync/settings",
      headers,
      payload: { auto_perceptual: false },
    });
    const results = await app.inject({
      method: "GET",
      url: "/library-sync/perceptual-results?limit=20&offset=0",
      headers,
    });
    expect(setting.json()).toEqual({
      success: true,
      data: { auto_perceptual: false },
    });
    expect(results.json()).toEqual({
      success: true,
      data: {
        items: [],
        assessment_revision: "relevance-v1",
        diagnostics: {
          candidate_limited_pairs: 0,
          truncated_videos: 0,
          suppressed_matches: 0,
        },
        total: 0,
        limit: 20,
        offset: 0,
      },
    });
    expect(perceptualResults).toHaveBeenCalledWith({
      limit: 20,
      offset: 0,
      view: "copies",
    });
  });
  it("returns the stable readiness error for perceptual starts and auto enable", async () => {
    const unavailable = Object.assign(new Error("private validation detail"), {
      code: "COPY_ENGINE_NOT_READY",
      statusCode: 503,
    });
    startRun.mockRejectedValueOnce(unavailable);
    updateSettings.mockRejectedValueOnce(unavailable);
    const [startResponse, settingResponse] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/library-sync/runs",
        headers,
        payload: { tasks: ["perceptual"] },
      }),
      app.inject({
        method: "PATCH",
        url: "/library-sync/settings",
        headers,
        payload: { auto_perceptual: true },
      }),
    ]);
    for (const response of [startResponse, settingResponse]) {
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
    }
  });
  it("accepts the separate similarity view and rejects unknown views", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/library-sync/perceptual-results?view=similarity&offset=2",
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(perceptualResults).toHaveBeenCalledWith({
      limit: 20,
      offset: 2,
      view: "similarity",
    });
    const invalid = await app.inject({
      method: "GET",
      url: "/library-sync/perceptual-results?view=all",
      headers,
    });
    expect(invalid.statusCode).toBe(400);
  });
});
