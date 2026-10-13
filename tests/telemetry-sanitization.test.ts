import { describe, expect, test } from "bun:test";
import {
  normalizeTelemetryLog,
  sanitizeTelemetryProperties,
} from "@/utils/telemetry";

describe("telemetry sanitization", () => {
  test("bounds large database errors before redaction without blocking the process", async () => {
    // A failed embedding INSERT can include megabytes of vector parameters.
    // Run separately so a synchronous redaction stall can be killed by the parent.
    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `
        import { normalizeTelemetryLog, sanitizeTelemetryProperties } from ${JSON.stringify(
          `${import.meta.dir}/../src/utils/telemetry.ts`
        )};
        const vector = "[-0.012345,0.043210,".repeat(100_000);
        const error = new Error("Failed query: INSERT INTO video_frame_embeddings params: " + vector);
        error.stack += "\\n    at " + vector;
        const log = normalizeTelemetryLog([{ error, videoId: 6337 }, "Visual indexing of a new storyboard failed"]);
        const properties = sanitizeTelemetryProperties({ detail: vector, url: vector });
        console.log(JSON.stringify({
          message: log.attributes["exception.message"],
          stack: log.attributes["exception.stacktrace"],
          detail: properties.detail,
          url: properties.url,
          videoId: log.attributes.videoId,
        }));
      `,
      ],
      { stdout: "pipe", stderr: "pipe" }
    );
    const deadline = setTimeout(() => child.kill(), 3_000);
    let result: number;
    try {
      result = await child.exited;
    } finally {
      clearTimeout(deadline);
    }
    expect(result).toBe(0);
    const output = JSON.parse(await new Response(child.stdout).text());
    expect(output.videoId).toBe(6337);
    expect(output.message).toContain("Failed query");
    expect(output.message.length).toBeLessThanOrEqual(4_096);
    expect(output.stack.length).toBeLessThanOrEqual(16_384);
    expect(output.detail.length).toBeLessThanOrEqual(4_096);
    expect(output.url.length).toBeLessThanOrEqual(4_096);
  });

  test("does not expose a partial filename or secret at the truncation boundary", () => {
    const normalized = normalizeTelemetryLog([
      { error: new Error("Failed: " + "private".repeat(1_000) + ".webm") },
      "Failure",
    ]);
    const properties = sanitizeTelemetryProperties({
      detail: "Failed: " + "private".repeat(1_000) + ".webm",
      note: "Failure " + " ".repeat(4_070) + "Bearer private-token-value",
    });
    expect(normalized.attributes["exception.message"]).not.toContain("private");
    expect(properties.detail).not.toContain("private");
    expect(properties.note).not.toContain("private-token");
  });

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
      "[REDACTED_MEDIA_PATH]"
    );
    expect(normalized.attributes["exception.stacktrace"]).toContain(
      "/app/src/worker.ts:2:3"
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
