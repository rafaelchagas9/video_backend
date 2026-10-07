import { describe, expect, it } from "bun:test";
import Fastify from "fastify";
import { env } from "@/config/env";
import { registerRequestTelemetryHooks } from "@/utils/request-telemetry";

describe("request telemetry HTTP hooks", () => {
  it("retains failures and slow diagnostics when successful analytics are disabled", async () => {
    const original = env.POSTHOG_CAPTURE_REQUEST_METRICS;
    env.POSTHOG_CAPTURE_REQUEST_METRICS = false;
    const events: Array<{
      event: string;
      properties: Record<string, unknown>;
    }> = [];
    const logs: Array<{ level: string; args: unknown[] }> = [];
    const app = Fastify();
    registerRequestTelemetryHooks(app, {
      captureTelemetryEvent(event, properties = {}) {
        events.push({ event, properties });
      },
      captureTelemetryLog(level, args) {
        logs.push({ level, args });
      },
    });
    app.addHook("onRequest", async (request) => {
      if (request.url.includes("slow") || request.url.includes("stream")) {
        request.telemetryStartTime = process.hrtime.bigint() - 3_000_000_000n;
      }
    });
    app.get("/ok", async () => ({ ok: true }));
    app.get("/slow", async () => ({ ok: true }));
    app.get("/api/videos/1/stream", async () => "media");
    app.get("/health", async (_request, reply) =>
      reply.code(503).send({ error: "unavailable" })
    );
    app.options("/options", async (_request, reply) =>
      reply.code(400).send({ error: "invalid" })
    );
    app.get("/throws", async () => {
      throw new Error("unexpected failure");
    });

    try {
      for (const path of ["/ok", "/slow", "/api/videos/1/stream"]) {
        expect((await app.inject(path)).statusCode).toBe(200);
      }
      expect(events).toHaveLength(0);
      expect(logs.map((log) => log.level)).toEqual(["warn"]);
      expect((await app.inject("/health?probe=1")).statusCode).toBe(503);
      expect(
        (await app.inject({ method: "OPTIONS", url: "/options" })).statusCode
      ).toBe(400);
      expect((await app.inject("/missing")).statusCode).toBe(404);
      expect((await app.inject("/throws")).statusCode).toBe(500);
      expect(events.map((item) => item.event)).toEqual(
        Array(4).fill("api request completed")
      );
      expect(events.map((item) => item.properties.statusCode)).toEqual([
        503, 400, 404, 500,
      ]);
      expect(logs.map((log) => log.level)).toEqual([
        "warn",
        "error",
        "warn",
        "warn",
        "error",
      ]);
      expect(events[0]!.properties.url).toBe("/health");
    } finally {
      env.POSTHOG_CAPTURE_REQUEST_METRICS = original;
      await app.close();
    }
  });
});
