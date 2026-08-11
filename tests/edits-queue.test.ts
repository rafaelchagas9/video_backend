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
