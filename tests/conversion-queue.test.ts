import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { QueueJobPayload } from "@/modules/conversion/conversion.types";

const queued: string[] = [];
const processing = new Map<string, string>();
const captureTelemetryException = mock(() => undefined);
const redis = {
  send: mock(async (command: string) => {
    if (command === "RPOP") return queued.pop() ?? null;
    if (command === "LLEN") return queued.length;
    throw new Error(`Unexpected Redis command: ${command}`);
  }),
  set: mock(async (key: string, value: string) => {
    processing.set(key, value);
    return "OK" as const;
  }),
  del: mock(async (key: string) => {
    processing.delete(key);
    return 1;
  }),
};

mock.module("@/config/env", () => ({ env: { CONVERSION_MAX_CONCURRENT: 1 } }));
mock.module("@/utils/logger", () => ({
  logger: {
    debug: mock(() => undefined),
    error: mock(() => undefined),
    info: mock(() => undefined),
    warn: mock(() => undefined),
  },
}));
mock.module("@/utils/telemetry", () => ({
  captureTelemetryException,
}));

const payload: QueueJobPayload = {
  jobId: 7,
  videoId: 9,
  preset: "balanced",
  inputPath: "/input.mkv",
  outputPath: "/output.mkv",
  deleteOriginal: false,
  createdAt: new Date().toISOString(),
};

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for conversion queue state");
}

describe("conversion queue shutdown", () => {
  beforeEach(() => {
    queued.length = 0;
    processing.clear();
    redis.send.mockClear();
    redis.set.mockClear();
    redis.del.mockClear();
    captureTelemetryException.mockClear();
  });

  it("waits for active conversion work before stop resolves", async () => {
    const { ConversionQueue } =
      await import("@/modules/conversion/conversion.queue");
    const queue = new ConversionQueue(redis);
    let started = false;
    let release: (() => void) | undefined;
    queue.setProcessor(
      mock(
        async () =>
          new Promise<void>((resolve) => {
            started = true;
            release = resolve;
          })
      )
    );

    queued.push(JSON.stringify(payload));
    await queue.start();
    await waitUntil(() => started);

    let stopped = false;
    const stopPromise = queue.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    release?.();
    await stopPromise;

    expect(stopped).toBe(true);
    expect(processing.size).toBe(0);
    expect((await queue.getStatus()).activeJobs).toBe(0);
  });

  it("captures a failed terminal job exactly once with a narrow FFmpeg fingerprint", async () => {
    const { FfmpegProcessError } =
      await import("@/modules/conversion/conversion.ffmpeg.service");
    const { ConversionQueue } =
      await import("@/modules/conversion/conversion.queue");
    const queue = new ConversionQueue(redis);
    const error = new FfmpegProcessError(
      "FFmpeg conversion failed with exit code 244",
      "hw",
      244,
      "Failed setup for format vaapi"
    );
    queue.setProcessor(mock(async () => Promise.reject(error)));

    queued.push(JSON.stringify(payload));
    await queue.start();
    await waitUntil(() => captureTelemetryException.mock.calls.length === 1);
    await queue.stop();

    expect(captureTelemetryException).toHaveBeenCalledTimes(1);
    expect(captureTelemetryException).toHaveBeenCalledWith(
      error,
      expect.objectContaining({
        source: "conversion_job",
        ffmpegExitCode: 244,
        ffmpegFailureKind: "hardware_acceleration",
        $exception_fingerprint:
          "conversion_ffmpeg:balanced:hw:244:hardware_acceleration",
      })
    );
  });
});
