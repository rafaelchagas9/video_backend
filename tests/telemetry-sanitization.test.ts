import { describe, expect, test } from "bun:test";
import {
  normalizeTelemetryLog,
  sanitizeTelemetryProperties,
} from "@/utils/telemetry";

describe("telemetry sanitization", () => {
  test("redacts secrets, bodies, commands, stderr, and media paths", () => {
    const sanitized = sanitizeTelemetryProperties({
      authorization: "Bearer phc_secret",
      requestBody: { password: "secret" },
      ffmpegCommand: "ffmpeg -i personal.webm output.mkv",
      stderr: "raw encoder output",
      outputPath: "/private/media/My Personal Video.mkv",
      url: "/api/search?q=private-title&token=private-token",
      remoteAddress: "192.0.2.1",
      statusCode: 500,
    });

    expect(sanitized.authorization).toBe("[REDACTED]");
    expect(sanitized.requestBody).toBe("[REDACTED]");
    expect(sanitized.ffmpegCommand).toBe("[REDACTED]");
    expect(sanitized.stderr).toBe("[REDACTED]");
    expect(sanitized.outputPath).toBe("[REDACTED]");
    expect(sanitized.url).toBe("/api/search");
    expect(sanitized.remoteAddress).toBe("[REDACTED]");
    expect(sanitized.statusCode).toBe(500);
  });

  test("preserves useful error context without media filenames", () => {
    const error = new Error("Conversion failed for personal-video.webm");
    error.stack = `${error.name}: ${error.message}\n    at /private/media/personal-video.webm:1:1\n    at /app/src/worker.ts:2:3`;
    const normalized = normalizeTelemetryLog([
      { error, jobId: 42 },
      "FFmpeg failed for /private/media/personal-video.webm",
    ]);

    expect(normalized.message).not.toContain("personal-video.webm");
    expect(normalized.message).toContain("[REDACTED_MEDIA_PATH]");
    expect(normalized.attributes.jobId).toBe(42);
    expect(normalized.attributes["exception.stacktrace"]).toContain(
      "[REDACTED_MEDIA_PATH]",
    );
    expect(normalized.attributes["exception.stacktrace"]).toContain(
      "/app/src/worker.ts:2:3",
    );
  });

  test("handles circular objects and bounds large values", () => {
    const circular: Record<string, unknown> = { safe: "value" };
    circular.self = circular;

    const sanitized = sanitizeTelemetryProperties({
      circular,
      detail: "x".repeat(10_000),
    });

    expect(sanitized.circular).toEqual({ safe: "value", self: "[Circular]" });
    expect(String(sanitized.detail).length).toBeLessThan(4_200);
    expect(String(sanitized.detail)).toContain("[truncated");
  });
});
