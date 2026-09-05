import { afterAll, expect, it, mock } from "bun:test";
import Fastify, { type FastifyRequest } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { buildConversionPreflight } from "@/modules/conversion/conversion.preflight";
import { buildConversionCalibration } from "@/modules/conversion/conversion.estimator";
import { CONVERSION_PRESETS } from "@/config/presets";
import { isDemoRequestAllowed } from "@/utils/demo-mode-policy";

mock.module("@/modules/auth/auth.middleware", () => ({
  authenticateUser: async (request: FastifyRequest) => {
    if (request.headers.authorization !== "Bearer fixture")
      throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
  },
}));
const estimate = mock(async (id: number, presetId: string) => {
  const preset = CONVERSION_PRESETS[presetId];
  if (!preset)
    throw Object.assign(new Error("Invalid preset"), { statusCode: 400 });
  return buildConversionPreflight(
    {
      id,
      width: 1920,
      height: 1080,
      codec: "h264",
      bitrate: 12_000_000,
      duration_seconds: 600,
      file_size_bytes: 900_000_000,
    },
    preset,
    buildConversionCalibration([])
  );
});
const createJob = mock(() => {
  throw new Error("Read-only estimate must never enqueue");
});
mock.module("@/modules/conversion/conversion.service", () => ({
  conversionService: { estimate, createJob },
}));
const { videoConversionRoutes } =
  await import("@/modules/conversion/conversion.routes");
const app = Fastify();
app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);
await app.register(videoConversionRoutes, { prefix: "/api/videos" });
afterAll(async () => app.close());

it("authenticates and validates the read-only estimate endpoint", async () => {
  const url = "/api/videos/42/conversion-estimate?preset=1080p_av1";
  expect((await app.inject({ url })).statusCode).toBe(401);
  expect(estimate).not.toHaveBeenCalled();
  const headers = { authorization: "Bearer fixture" };
  const response = await app.inject({ url, headers });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    success: true,
    data: { video_id: 42, preset: "1080p_av1", recommendation: "recommended" },
  });
  for (const invalid of [
    "/api/videos/no-id/conversion-estimate?preset=1080p_av1",
    "/api/videos/42/conversion-estimate",
    "/api/videos/42/conversion-estimate?preset=missing",
  ]) {
    expect((await app.inject({ url: invalid, headers })).statusCode).toBe(400);
  }
  expect(createJob).not.toHaveBeenCalled();
});

it("permits demo estimates under the existing demo read policy", () => {
  expect(
    isDemoRequestAllowed(
      "GET",
      "/api/videos/42/conversion-estimate?preset=1080p_av1"
    )
  ).toBe(true);
});
