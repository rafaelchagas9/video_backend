import { afterAll, beforeEach, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";

process.env.NODE_ENV = "test";
process.env.DEMO_MODE = "true";
process.env.POSTGRES_USER = "test_user";
process.env.POSTGRES_PASSWORD = "test_password";
process.env.SESSION_SECRET =
  "test-session-secret-with-at-least-thirty-two-characters";
process.env.POSTHOG_API_KEY = "";
mock.module("@/modules/auth/auth.middleware", () => ({
  authenticateUser: async (request: {
    headers: Record<string, unknown>;
    user?: { id: number };
  }) => {
    const id = Number(request.headers["x-test-user"]);
    if (!id)
      throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
    request.user = { id };
  },
}));
const directory = mkdtempSync(join(tmpdir(), "library-personalization-"));
const { env } = await import("@/config/env");
env.DEMO_MODE = true;
const { setDemoDatabasePathForTests, initializeDemoDatabase, getDemoSqlite } =
  await import("@/database/demo/client");
setDemoDatabasePathForTests(join(directory, "demo.sqlite"));
initializeDemoDatabase();
const sqlite = getDemoSqlite();
const stamp = "2026-01-01T00:00:00.000Z";
sqlite
  .query(
    "INSERT INTO demo_videos (id,file_path,file_name,directory_id,file_size_bytes,is_available,indexed_at,created_at,updated_at) VALUES (1,'/synthetic.mp4','Synthetic',1,100,1,?,?,?)"
  )
  .run(stamp, stamp, stamp);
const { savedViewsRoutes } =
  await import("@/modules/saved-views/saved-views.routes");
const { videoStatsRoutes } =
  await import("@/modules/video-stats/video-stats.routes");
const { isDemoRequestAllowed } = await import("@/utils/demo-mode-policy");
const app = Fastify();
app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);
app.setErrorHandler((error, _request, reply) => {
  const statusCode = Number(
    (error as { statusCode?: number }).statusCode ?? 500
  );
  return reply.code(statusCode).send({
    success: false,
    error: { message: (error as Error).message, statusCode },
  });
});
await app.register(savedViewsRoutes, { prefix: "/api/saved-views" });
await app.register(videoStatsRoutes, { prefix: "/api/videos" });
afterAll(async () => {
  await app.close();
  setDemoDatabasePathForTests(null);
  rmSync(directory, { recursive: true, force: true });
});
beforeEach(() => {
  sqlite.exec(
    "DELETE FROM demo_saved_library_views; DELETE FROM demo_video_stats;"
  );
  for (const user of [1, 2]) {
    sqlite
      .query(
        "INSERT INTO demo_video_stats (user_id,video_id,play_count,total_watch_seconds,session_watch_seconds,session_play_counted,last_position_seconds,last_played_at,last_watch_at,created_at,updated_at) VALUES (?,1,3,450,50,1,?,?,?, ?,?)"
      )
      .run(user, user * 100, stamp, stamp, stamp, stamp);
  }
});
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const headers = (user = 1) => ({ "x-test-user": String(user) });
const put = (viewId: string, name: string, user = 1, filters = {}) =>
  app.inject({
    method: "PUT",
    url: `/api/saved-views/${viewId}`,
    headers: headers(user),
    payload: { id: viewId, name, filters },
  });
const list = async (user = 1) =>
  (
    await app.inject({ url: "/api/saved-views/", headers: headers(user) })
  ).json().data;
const progress = (position: number | null, expected: number | null, user = 1) =>
  app.inject({
    method: "PATCH",
    url: "/api/videos/1/progress",
    headers: headers(user),
    payload: {
      last_position_seconds: position,
      expected_position_seconds: expected,
    },
  });

it("scopes saved-view create, update, list and delete to the authenticated user", async () => {
  expect(
    (
      await put(id, "  My view  ", 1, {
        search: "synthetic",
        page: 2,
        limit: 12,
        include: [],
      })
    ).statusCode
  ).toBe(200);
  expect((await put(id, "Other user's view", 2)).statusCode).toBe(200);
  const [view] = await list();
  expect(view.name).toBe("My view");
  expect(view.filters.search).toBe("synthetic");
  expect(view.filters).not.toHaveProperty("page");
  expect(view.filters).not.toHaveProperty("limit");
  expect(view.filters).not.toHaveProperty("include");
  expect((await put(id, "Updated")).statusCode).toBe(200);
  expect(await list()).toHaveLength(1);
  expect(
    (
      await app.inject({
        method: "DELETE",
        url: `/api/saved-views/${id}`,
        headers: headers(),
      })
    ).statusCode
  ).toBe(200);
  expect(await list()).toEqual([]);
  expect((await list(2))[0].name).toBe("Other user's view");
});
it("validates saved-view identity, names, filters and authentication before writes", async () => {
  for (const name of [" ", "x".repeat(81)])
    expect((await put(id, name)).statusCode).toBe(400);
  expect((await put(id, "Invalid", 1, { sort: "unknown" })).statusCode).toBe(
    400
  );
  expect(
    (await put(id, "Unsupported", 1, { futureFilter: true })).statusCode
  ).toBe(400);
  expect(
    (
      await app.inject({
        method: "PUT",
        url: `/api/saved-views/${id}`,
        headers: headers(),
        payload: { id: crypto.randomUUID(), name: "Mismatch", filters: {} },
      })
    ).statusCode
  ).toBe(400);
  for (const method of ["GET", "PUT", "DELETE"] as const) {
    const response = await app.inject({
      method,
      url: method === "GET" ? "/api/saved-views/" : `/api/saved-views/${id}`,
      ...(method === "PUT"
        ? { payload: { id, name: "Private", filters: {} } }
        : {}),
    });
    expect(response.statusCode).toBe(401);
  }
  expect(await list()).toEqual([]);
});
it("returns the same canonical filters on save and load, including default ordering", async () => {
  const response = await put(id, "Canonical", 1, {
    minDuration: "60",
    isWatched: false,
    minPlayCount: "2",
    searchFullPath: "true",
    include_hidden: "true",
    sort: "duration_seconds",
    order: "asc",
    search: "Synthetic",
  });
  expect(response.statusCode).toBe(200);
  const saved = response.json().data;
  expect(saved.filters).toMatchObject({
    minDuration: 60,
    isWatched: false,
    minPlayCount: 2,
    searchFullPath: true,
    include_hidden: true,
    sort: "duration_seconds",
    order: "asc",
    search: "Synthetic",
  });
  expect((await list())[0]).toEqual(saved);
  const defaults = await put(id, "Defaults");
  expect(defaults.json().data.filters).toMatchObject({
    sort: "created_at",
    order: "desc",
    searchFullPath: false,
    include_hidden: false,
  });
  expect((await list())[0]).toEqual(defaults.json().data);
});
it("caps each user's views at 50 while allowing updates and other users to save", async () => {
  for (let index = 0; index < 50; index++)
    expect(
      (await put(index === 0 ? id : crypto.randomUUID(), `View ${index}`))
        .statusCode
    ).toBe(200);
  expect((await put(crypto.randomUUID(), "Overflow")).statusCode).toBe(400);
  expect((await put(id, "Renamed at cap")).statusCode).toBe(200);
  expect(await list()).toHaveLength(50);
  expect((await put(crypto.randomUUID(), "Other", 2)).statusCode).toBe(200);
});
it("clears and restores progress without inflating statistics or changing another user", async () => {
  const snapshot = () =>
    sqlite
      .query(
        "SELECT user_id,play_count,total_watch_seconds,session_watch_seconds,session_play_counted,last_played_at,last_watch_at,created_at FROM demo_video_stats ORDER BY user_id"
      )
      .all();
  const before = snapshot();
  const cleared = await progress(null, 100);
  expect(cleared.statusCode).toBe(200);
  expect(cleared.json().data.stats.last_position_seconds).toBeNull();
  const restored = await progress(100, null);
  expect(restored.statusCode).toBe(200);
  expect(restored.json().data.stats.last_position_seconds).toBe(100);
  expect(snapshot()).toEqual(before);
  expect(
    sqlite
      .query(
        "SELECT last_position_seconds FROM demo_video_stats WHERE user_id=2"
      )
      .get()
  ).toEqual({ last_position_seconds: 200 });
});
it("rejects stale undo after newer playback and returns the requesting user's position", async () => {
  expect((await progress(null, 200, 2)).statusCode).toBe(200);
  const updated = await progress(240, null, 2);
  expect(updated.statusCode).toBe(200);
  expect(updated.json().data.stats.last_position_seconds).toBe(240);
  expect((await progress(200, null, 2)).statusCode).toBe(409);
  expect(
    sqlite
      .query(
        "SELECT last_position_seconds FROM demo_video_stats WHERE user_id=2"
      )
      .get()
  ).toEqual({ last_position_seconds: 240 });
});
it("rejects invalid or unauthenticated progress writes", async () => {
  expect((await progress(-1, 100)).statusCode).toBe(400);
  expect((await progress(0, 100, 0)).statusCode).toBe(401);
  expect(
    (
      await app.inject({
        method: "PATCH",
        url: "/api/videos/999/progress",
        headers: headers(),
        payload: {
          last_position_seconds: null,
          expected_position_seconds: null,
        },
      })
    ).statusCode
  ).toBe(404);
});
it("allows only the new demo route methods with actual UUID and video IDs", () => {
  expect(isDemoRequestAllowed("GET", "/api/saved-views/")).toBe(true);
  expect(isDemoRequestAllowed("PUT", `/api/saved-views/${id}`)).toBe(true);
  expect(isDemoRequestAllowed("DELETE", `/api/saved-views/${id}`)).toBe(true);
  expect(isDemoRequestAllowed("PATCH", "/api/videos/1/progress")).toBe(true);
  expect(isDemoRequestAllowed("POST", `/api/saved-views/${id}`)).toBe(false);
});
