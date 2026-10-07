import { describe, expect, it } from "bun:test";
import type { FastifyRequest } from "fastify";
import {
  getRequestTelemetryLogLevel,
  shouldTrackRequestMetrics,
} from "@/utils/telemetry";

function request(url: string): FastifyRequest {
  return { method: "GET", url } as FastifyRequest;
}

describe("telemetry request filtering", () => {
  it("ignores multiplayer pending-request polling", () => {
    expect(
      shouldTrackRequestMetrics(
        request("/api/multiplayer-remote/sessions/80/join-requests/pending"),
        200,
        true
      )
    ).toBe(false);
  });

  it("disables successful request events while respecting explicit opt-in", () => {
    const normal = request("/api/videos?limit=20");
    expect(shouldTrackRequestMetrics(normal, 200, false)).toBe(false);
    expect(shouldTrackRequestMetrics(normal, 200, true)).toBe(true);
  });

  it("preserves every HTTP failure independently of flag and route exclusions", () => {
    for (const path of [
      "/health?probe=1",
      "/docs",
      "/api/events/stream",
      "/api/videos/1/stream",
      "/api/multiplayer-remote/sessions/80/join-requests/pending",
    ]) {
      for (const method of ["GET", "OPTIONS"]) {
        const failed = { ...request(path), method } as FastifyRequest;
        for (const status of [400, 401, 404, 429, 500, 503]) {
          expect(shouldTrackRequestMetrics(failed, status, false)).toBe(true);
          expect(getRequestTelemetryLogLevel(failed, status, 1)).toBe(
            status >= 500 ? "error" : "warn"
          );
        }
      }
    }
  });

  it("applies successful request exclusions to paths with query strings", () => {
    for (const path of [
      "/health?probe=1",
      "/docs?x=1",
      "/api/events/stream?client=1",
    ]) {
      expect(shouldTrackRequestMetrics(request(path), 200, true)).toBe(false);
    }
  });

  it("logs slow non-streaming responses independently of successful analytics", () => {
    const normal = request("/api/videos");
    expect(shouldTrackRequestMetrics(normal, 200, false)).toBe(false);
    expect(getRequestTelemetryLogLevel(normal, 200, 1_999)).toBeNull();
    expect(getRequestTelemetryLogLevel(normal, 200, 2_000)).toBe("warn");
    expect(
      getRequestTelemetryLogLevel(
        request("/api/videos/1/cast-sessions/2"),
        200,
        2_000
      )
    ).toBe("warn");
  });

  it("does not mistake playback or long-lived connections for slow requests", () => {
    for (const path of [
      "/api/videos/1/stream?token=x",
      "/api/recordings/live/channels/1/stream/seg-1.ts",
      "/api/cast/token/index.m3u8",
      "/api/videos/1/preview.mp4?v=1",
      "/api/events/stream",
      "/api/multiplayer-remote/ws",
    ]) {
      expect(
        getRequestTelemetryLogLevel(request(path), 200, 60_000)
      ).toBeNull();
      expect(getRequestTelemetryLogLevel(request(path), 503, 60_000)).toBe(
        "error"
      );
    }
  });
});
