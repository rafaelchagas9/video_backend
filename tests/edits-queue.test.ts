import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { EditQueuePayload } from "@/modules/edits/edits.types";

const lists = new Map<string, string[]>();
const redisCalls: Array<{ command: string; args: string[] }> = [];

function list(key: string): string[] {
  const existing = lists.get(key);
  if (existing) return existing;
  const created: string[] = [];
  lists.set(key, created);
  return created;
}

const redisSend = mock(async (command: string, args: string[]) => {
  redisCalls.push({ command, args });
  const normalized = command.toUpperCase();

  if (normalized === "EVAL") {
    const values = list(args[2]!);
    const index = values.indexOf(args[4]!);
    if (index < 0) return 0;
    values.splice(index, 1);
    return list(args[3]!).push(args[4]!);
  }
  if (normalized === "LPUSH") {
    return list(args[0]!).unshift(args[1]!);
  }
  if (normalized === "LRANGE") {
    return [...list(args[0]!)];
  }
  if (normalized === "LLEN") {
    return list(args[0]!).length;
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
    for (let index = 0; index < values.length;) {
      if (values[index] === target && (count === 0 || removed < count)) {
        values.splice(index, 1);
        removed++;
      } else {
        index++;
      }
    }
    return removed;
  }

  throw new Error(`Unsupported fake Redis command: ${command}`);
});

mock.module("@/utils/logger", () => ({
  logger: {
    debug: mock(() => undefined),
    error: mock(() => undefined),
    info: mock(() => undefined),
    warn: mock(() => undefined),
  },
}));
mock.module("@/utils/telemetry", () => ({
  captureTelemetryException: mock(() => undefined),
}));

const claimForProcessing = mock(async () => false);
const getById = mock(async () => {
  throw new Error(
    "A cancelled job must not be read after its claim is refused"
  );
});
const markCompleted = mock(async () => true);
const markFailed = mock(async () => true);
const updateProgress = mock(async () => true);
const recoverableQueuePayloads = mock(
  async (): Promise<EditQueuePayload[]> => []
);
const findVideoById = mock(async () => {
  throw new Error("A cancelled job must not load its source video");
});

mock.module("@/modules/edits/edits.service", () => ({
  calculateExpectedDuration: mock(() => 5),
  resolveSafeOutputTarget: mock(async () => {
    throw new Error("A cancelled job must not resolve an output target");
  }),
  validateEditRequest: mock(() => undefined),
  editsService: {
    claimForProcessing,
    getById,
    markCompleted,
    markFailed,
    updateProgress,
    recoverableQueuePayloads,
  },
}));
mock.module("@/modules/videos/videos.service", () => ({
  videosService: {
    findById: findVideoById,
    registerLocalFile: mock(async () => ({ id: 1 })),
    removeCatalogRecord: mock(async () => undefined),
  },
}));
mock.module("@/modules/thumbnails/thumbnails.service", () => ({
  thumbnailsService: { generate: mock(async () => undefined) },
}));
mock.module("@/modules/conversion/conversion.ffmpeg.service", () => ({
  classifyFfmpegFailure: mock(() => "unknown"),
  ffmpegService: {
    getMaxRate: mock(() => "5M"),
    calculateTargetBitrate: mock(() => ({
      bitrate: "4M",
      maxrate: "5M",
      bufsize: "10M",
    })),
  },
}));
mock.module("@/utils/performance-profiler", () => ({
  recordPerfStage: mock(async () => undefined),
}));
mock.module("@/config/env", () => ({
  env: {
    FFMPEG_PATH: "/usr/bin/false",
    VAAPI_DEVICE: "/dev/dri/renderD128",
  },
}));

const payload = (jobId: number): EditQueuePayload => ({
  jobId,
  videoId: jobId + 100,
  outputConfig: {
    directory_id: 1,
    file_name: `edit-${jobId}.mkv`,
    format: "mkv",
    video_codec: "av1",
    audio_codec: "opus",
  },
  timelineConfig: { segments: [{ start: 0, end: 5, speed: 1 }] },
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for queue state");
}

async function waitUntilAsync(
  predicate: () => Promise<boolean>
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for asynchronous queue state");
}

describe("edit queue cancellation and recovery", () => {
  let EditsQueue: typeof import("@/modules/edits/edits.queue").EditsQueue;

  beforeAll(async () => {
    ({ EditsQueue } = await import("@/modules/edits/edits.queue"));
  });

  beforeEach(() => {
    lists.clear();
    redisCalls.length = 0;
    redisSend.mockClear();
  });

  it("serializes delayed claims when simultaneous enqueues compete for one slot", async () => {
    const { EditsQueue } = await import("@/modules/edits/edits.queue");
    let releaseClaim!: () => void;
    const claimGate = new Promise<void>((resolve) => {
      releaseClaim = resolve;
    });
    let pendingClaims = 0;
    const base = { send: redisSend };
    const queue = new EditsQueue({
      ...base,
      send: async (command, args) => {
        const result = await base.send(command, args);
        if (command === "RPOPLPUSH" && args[0] === "edits:jobs" && result) {
          pendingClaims++;
          await claimGate;
        }
        return result;
      },
    });
    let active = 0;
    let maximumActive = 0;
    const started: number[] = [];
    const releases: Array<() => void> = [];
    queue.setProcessor(async (job) => {
      started.push(job.jobId);
      maximumActive = Math.max(maximumActive, ++active);
      await new Promise<void>((resolve) => {
        releases.push(resolve);
      });
      active--;
    });
    await queue.start();
    await queue.enqueue(payload(71));
    await waitUntil(() => pendingClaims > 0);
    await queue.enqueue(payload(72));
    await new Promise((resolve) => setTimeout(resolve, 5));
    releaseClaim();
    await waitUntil(() => started.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const observedMaximum = maximumActive;
    releases.shift()?.();
    await waitUntil(() => started.length === 2);
    for (const release of releases) release();
    await queue.stop();
    expect(observedMaximum).toBe(1);
    expect(maximumActive).toBe(1);
    expect(started).toEqual([71, 72]);
    expect(list("edits:processing")).toHaveLength(0);
  });

  it("waits for a delayed claim at shutdown and requeues it without starting a renderer", async () => {
    const { EditsQueue } = await import("@/modules/edits/edits.queue");
    let releaseClaim!: () => void;
    const claimGate = new Promise<void>((resolve) => {
      releaseClaim = resolve;
    });
    let claimed = false;
    const base = { send: redisSend };
    const queue = new EditsQueue({
      ...base,
      send: async (command, args) => {
        const result = await base.send(command, args);
        if (
          command === "RPOPLPUSH" &&
          args[0] === "edits:jobs" &&
          result &&
          !claimed
        ) {
          claimed = true;
          await claimGate;
        }
        return result;
      },
    });
    const processor = mock(async () => undefined);
    queue.setProcessor(processor);
    await queue.enqueue(payload(73));
    await queue.start();
    await waitUntil(() => claimed);
    let stopped = false;
    const stopping = queue.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const stoppedBeforeClaim = stopped;
    releaseClaim();
    await stopping;
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(stoppedBeforeClaim).toBe(false);
    expect(processor).not.toHaveBeenCalled();
    expect(list("edits:processing")).toHaveLength(0);
    expect(list("edits:jobs")).toHaveLength(1);
    await queue.start();
    await waitUntil(() => processor.mock.calls.length === 1);
    await queue.stop();
    expect(list("edits:jobs")).toHaveLength(0);
    expect(list("edits:processing")).toHaveLength(0);
  });

  it("does not restart rendering when shutdown races with recovery", async () => {
    const { EditsQueue } = await import("@/modules/edits/edits.queue");
    const queue = new EditsQueue({ send: redisSend });
    let releaseRecovery!: () => void;
    const recoveryGate = new Promise<void>((resolve) => {
      releaseRecovery = resolve;
    });
    let recovering = false;
    queue.setRecoveryProvider(async () => {
      recovering = true;
      await recoveryGate;
      return [payload(74)];
    });
    const processor = mock(async () => undefined);
    queue.setProcessor(processor);
    const starting = queue.start();
    await waitUntil(() => recovering);
    let stopped = false;
    const stopping = queue.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    releaseRecovery();
    await Promise.all([starting, stopping]);
    expect(processor).not.toHaveBeenCalled();
    expect(await queue.getStatus()).toMatchObject({
      isProcessing: false,
      activeJobs: 0,
      queueLength: 1,
    });
    await queue.start();
    await waitUntil(() => processor.mock.calls.length === 1);
    await queue.stop();
  });

  it("retries an unexpected processor failure after releasing its slot", async () => {
    const queue = new EditsQueue({ send: redisSend });
    const recover = mock(async () => []);
    queue.setRecoveryProvider(recover);
    let attempts = 0;
    queue.setProcessor(async () => {
      if (++attempts === 1)
        throw new Error("Transient test infrastructure failure");
    });
    await queue.enqueue(payload(78));
    await queue.start();
    await waitUntil(() => attempts === 2);
    await queue.stop();
    expect(recover).toHaveBeenCalledTimes(2);
    expect(list("edits:jobs")).toHaveLength(0);
    expect(list("edits:processing")).toHaveLength(0);
  });

  it("removes a cancelled queued payload before it can be claimed", async () => {
    const queue = new EditsQueue({ send: redisSend });
    const processor = mock(async () => undefined);
    queue.setProcessor(processor);

    await queue.enqueue(payload(1));
    expect(await queue.getStatus()).toMatchObject({ queueLength: 1 });

    await queue.cancel(1);

    expect(await queue.getStatus()).toMatchObject({ queueLength: 0 });
    expect(processor).not.toHaveBeenCalled();
    expect(list("edits:processing")).toHaveLength(0);
  });

  it("aborts an active processor and acknowledges its processing claim", async () => {
    const queue = new EditsQueue({ send: redisSend });
    let receivedSignal: AbortSignal | null = null;
    let processingStarted = false;
    let observedAbort = false;
    queue.setProcessor(
      mock(
        async (_job: EditQueuePayload, signal: AbortSignal) =>
          new Promise<void>((resolve) => {
            receivedSignal = signal;
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
    await waitUntil(
      () => observedAbort && list("edits:processing").length === 0
    );
    await waitUntilAsync(
      async () => (await queue.getStatus()).activeJobs === 0
    );

    expect(receivedSignal).not.toBeNull();
    expect((receivedSignal as unknown as AbortSignal).aborted).toBe(true);
    expect(await queue.getStatus()).toMatchObject({
      queueLength: 0,
      activeJobs: 0,
    });
    await queue.stop();
  });

  it("aborts and drains active work before shutdown completes", async () => {
    const queue = new EditsQueue({ send: redisSend });
    let processingStarted = false;
    let observedAbort = false;
    queue.setProcessor(
      mock(
        async (_job: EditQueuePayload, signal: AbortSignal) =>
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
    await queue.enqueue(payload(6));
    await waitUntil(() => processingStarted);

    await queue.stop();

    expect(observedAbort).toBe(true);
    expect(await queue.getStatus()).toMatchObject({
      activeJobs: 0,
      isProcessing: false,
    });
    expect(list("edits:processing")).toHaveLength(0);
  });

  it("recovers claimed and database jobs exactly once without duplicates", async () => {
    const claimed = JSON.stringify(payload(3));
    const alreadyQueued = JSON.stringify(payload(4));
    list("edits:processing").push(claimed);
    list("edits:jobs").push(alreadyQueued);

    const queue = new EditsQueue({ send: redisSend });
    const recover = mock(async () => [payload(3), payload(4), payload(5)]);
    queue.setRecoveryProvider(recover);

    await queue.start();
    expect(list("edits:processing")).toHaveLength(0);
    expect(
      list("edits:jobs")
        .map((value) => JSON.parse(value) as EditQueuePayload)
        .map((job) => job.jobId)
        .sort((left, right) => left - right)
    ).toEqual([3, 4, 5]);

    await queue.stop();
    await queue.start();
    expect(
      list("edits:jobs")
        .map((value) => JSON.parse(value) as EditQueuePayload)
        .map((job) => job.jobId)
        .sort((left, right) => left - right)
    ).toEqual([3, 4, 5]);
    expect(
      redisCalls.filter(
        ({ command, args }) =>
          command === "LPUSH" &&
          (JSON.parse(args[1]!) as EditQueuePayload).jobId === 5
      )
    ).toHaveLength(1);
    await queue.stop();
  });
});

describe("edit processor cancellation claim", () => {
  let EditsProcessor: typeof import("@/modules/edits/edits.processor").EditsProcessor;

  beforeAll(async () => {
    ({ EditsProcessor } = await import("@/modules/edits/edits.processor"));
  });

  it("skips a job whose queued claim was cancelled and never resurrects it", async () => {
    const processor = new EditsProcessor();

    await processor.processJob(payload(42));

    expect(claimForProcessing).toHaveBeenCalledTimes(1);
    expect(claimForProcessing).toHaveBeenCalledWith(42);
    expect(findVideoById).not.toHaveBeenCalled();
    expect(getById).not.toHaveBeenCalled();
    expect(updateProgress).not.toHaveBeenCalled();
    expect(markCompleted).not.toHaveBeenCalled();
    expect(markFailed).not.toHaveBeenCalled();
  });
});
