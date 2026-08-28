import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { QueueJobPayload } from "@/modules/conversion/conversion.types";

const lists = new Map<string, string[]>();
const captureTelemetryException = mock(() => undefined);

function list(key: string): string[] {
  const existing = lists.get(key);
  if (existing) return existing;
  const created: string[] = [];
  lists.set(key, created);
  return created;
}

const redis = {
  send: mock(async (command: string, args: string[]) => {
    const normalized = command.toUpperCase();
    if (normalized === "LPUSH") {
      return list(args[0]!).unshift(args[1]!);
    }
    if (normalized === "LRANGE") {
      return [...list(args[0]!)];
    }
    if (normalized === "LLEN") {
      return list(args[0]!).length;
    }
    if (normalized === "SCAN") {
      return [
        "0",
        [...lists.keys()].filter((key) =>
          key.startsWith("conversion:processing:")
        ),
      ];
    }
    if (normalized === "RPOPLPUSH") {
      const value = list(args[0]!).pop();
      if (value === undefined) return null;
      list(args[1]!).unshift(value);
      return value;
    }
    if (normalized === "LREM") {
      const values = list(args[0]!);
      const count = Number(args[1]);
      const target = args[2];
      let removed = 0;
      for (let index = 0; index < values.length; ) {
        if (values[index] === target && (count === 0 || removed < count)) {
          values.splice(index, 1);
          removed++;
        } else {
          index++;
        }
      }
      return removed;
    }
    throw new Error(`Unexpected Redis command: ${command}`);
  }),
  del: mock(async (key: string) => {
    const existed = lists.delete(key);
    return existed ? 1 : 0;
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

const payload = (jobId: number): QueueJobPayload => ({
  jobId,
  videoId: jobId + 2,
  preset: "balanced",
  inputPath: `/input-${jobId}.mkv`,
  outputPath: `/output-${jobId}.mkv`,
  deleteOriginal: false,
  createdAt: new Date().toISOString(),
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for conversion queue state");
}

async function waitUntilAsync(
  predicate: () => Promise<boolean>
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for asynchronous conversion queue state");
}

describe("conversion queue cancellation and recovery", () => {
  beforeEach(() => {
    lists.clear();
    redis.send.mockClear();
    redis.del.mockClear();
    captureTelemetryException.mockClear();
  });

  it("removes a cancelled queued payload before it can be claimed", async () => {
    const { ConversionQueue } =
      await import("@/modules/conversion/conversion.queue");
    const queue = new ConversionQueue(redis);
    const processor = mock(async () => undefined);
    queue.setProcessor(processor);

    await queue.enqueue(payload(1));
    expect(await queue.getStatus()).toMatchObject({ queueLength: 1 });

    await queue.cancel(1);

    expect(await queue.getStatus()).toMatchObject({ queueLength: 0 });
    expect(processor).not.toHaveBeenCalled();
  });

  it("aborts an active processor and acknowledges its durable claim", async () => {
    const { ConversionQueue } =
      await import("@/modules/conversion/conversion.queue");
    const queue = new ConversionQueue(redis);
    let processingStarted = false;
    let observedAbort = false;
    queue.setProcessor(
      mock(
        async (_job: QueueJobPayload, signal: AbortSignal) =>
          new Promise<void>((resolve) => {
            processingStarted = true;
            signal.addEventListener(
              "abort",
              () => {
                observedAbort = true;
                resolve();
              },
              { once: true }
            );
          })
      )
    );

    await queue.start();
    await queue.enqueue(payload(2));
    await waitUntil(() => processingStarted);

    await queue.cancel(2);
    await waitUntilAsync(
      async () => (await queue.getStatus()).activeJobs === 0
    );

    expect(observedAbort).toBe(true);
    expect(list("conversion:processing")).toHaveLength(0);
    await queue.stop();
  });

  it("replays claimed jobs and restores missing database jobs once", async () => {
    const { ConversionQueue } =
      await import("@/modules/conversion/conversion.queue");
    const queue = new ConversionQueue(redis);
    const recoveredClaim = payload(3);
    list("conversion:processing").push(JSON.stringify(recoveredClaim));
    list("conversion:processing:99").push("legacy marker");
    queue.setRecoveryProvider(async () => [recoveredClaim, payload(4)]);
    const processed: number[] = [];
    queue.setProcessor(
      mock(async (job: QueueJobPayload) => {
        processed.push(job.jobId);
      })
    );

    await queue.start();
    await waitUntil(() => processed.length === 2);
    await waitUntilAsync(
      async () => (await queue.getStatus()).activeJobs === 0
    );

    expect(processed.sort()).toEqual([3, 4]);
    expect(list("conversion:jobs")).toHaveLength(0);
    expect(list("conversion:processing")).toHaveLength(0);
    expect(lists.has("conversion:processing:99")).toBe(false);
    await queue.stop();
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

    list("conversion:jobs").push(JSON.stringify(payload(5)));
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
    expect(list("conversion:processing")).toHaveLength(0);
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

    list("conversion:jobs").push(JSON.stringify(payload(6)));
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
