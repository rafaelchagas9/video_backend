import { afterAll, expect, it, mock } from "bun:test";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";

mock.module("@/modules/auth/auth.middleware", () => ({
  authenticateUser: async (request: {
    headers: { authorization?: string };
  }) => {
    if (!request.headers.authorization)
      throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
  },
}));
const queueGenerate = mock(async () => {});
const generationStatus = { video_id: 42, status: "queued", updated_at: null };
mock.module("@/modules/storyboards/storyboards.service", () => ({
  storyboardsService: {
    generate: async () => {
      throw new Error("Publication failed");
    },
    queueGenerate,
    getGenerationStatus: async () => generationStatus,
    findByVideoId: async () => null,
  },
}));
const { storyboardsRoutes } =
  await import("@/modules/storyboards/storyboards.routes");
const app = Fastify();
app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);
// The application's global error envelope.
app.setErrorHandler((error, _request, reply) => {
  const statusCode = Number(
    (error as { statusCode?: number }).statusCode ?? 500
  );
  return reply.code(statusCode).send({
    success: false,
    error: { message: (error as Error).message, statusCode },
  });
});
await app.register(storyboardsRoutes, { prefix: "/api/videos" });
afterAll(() => app.close());

it("serializes missing storyboard and unauthenticated status responses", async () => {
  const missing = await app.inject({
    url: "/api/videos/42/storyboard",
    headers: { authorization: "fixture" },
  });
  expect(missing.statusCode).toBe(404);
  expect(missing.json().error.message).toBe(
    "Storyboard not found for this video"
  );
  const unauthenticated = await app.inject({
    url: "/api/videos/42/storyboard/status",
  });
  expect(unauthenticated.statusCode).toBe(401);
  expect(unauthenticated.json().error.message).toBe("Unauthorized");
});

it("preserves the original error instead of failing response serialization", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/api/videos/42/storyboard",
    headers: { authorization: "fixture" },
    payload: {},
  });
  expect(response.statusCode).toBe(500);
  expect(response.json<Record<string, unknown>>()).toEqual({
    success: false,
    error: { message: "Publication failed", statusCode: 500 },
  });
});

it("accepts background generation and exposes authenticated status", async () => {
  const url = "/api/videos/42/storyboard?background=true";
  expect(
    (await app.inject({ method: "POST", url, payload: {} })).statusCode
  ).toBe(401);
  expect(queueGenerate).not.toHaveBeenCalled();
  const response = await app.inject({
    method: "POST",
    url,
    headers: { authorization: "fixture" },
    payload: { intervalSeconds: 10 },
  });
  expect(response.statusCode).toBe(202);
  expect(queueGenerate).toHaveBeenCalledWith(42, { intervalSeconds: 10 }, true);
  expect(response.json().data.status).toBe("queued");
  const status = await app.inject({
    url: "/api/videos/42/storyboard/status",
    headers: { authorization: "fixture" },
  });
  expect(status.statusCode).toBe(200);
  expect(status.json().data).toEqual(generationStatus);
});
