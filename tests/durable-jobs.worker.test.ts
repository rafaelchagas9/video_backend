import { describe, expect, it } from "bun:test";
import {
  DurableJobWorker,
  DurableJobsService,
  InMemoryDurableJobStore,
} from "@/modules/durable-jobs";

function createHarness() {
  let now = new Date("2026-08-28T12:00:00.000Z");
  let token = 0;
  const service = new DurableJobsService(new InMemoryDurableJobStore(), {
    now: () => now,
    createLeaseToken: () => `lease-${++token}`,
  });

  return {
    service,
    advance(milliseconds: number) {
      now = new Date(now.getTime() + milliseconds);
    },
  };
}

describe("DurableJobWorker", () => {
  it("runs a claimed handler, persists a checkpoint, and acknowledges completion", async () => {
    const { service } = createHarness();
    const queued = await service.enqueue({
      kind: "vision.face-analysis",
      payload: { videoId: 42 },
    });
    const observed: Array<Record<string, unknown>> = [];
    const worker = new DurableJobWorker(service, {
      workerId: "worker-a",
      leaseDurationMs: 30_000,
      handlers: {
        "vision.face-analysis": async (job, context) => {
          observed.push(job.payload);
          await context.checkpoint({
            stage: "analyzing",
            completedUnits: 1,
            totalUnits: 1,
          });
        },
      },
    });

    expect(await worker.runOnce()).toBe(true);
    expect(observed).toEqual([{ videoId: 42 }]);
    expect(
      await service.claim({ workerId: "worker-b", leaseDurationMs: 1 })
    ).toBeNull();

    const completed = await service.get(queued.id);
    expect(completed).toMatchObject({
      status: "completed",
      checkpoint: {
        stage: "analyzing",
        completedUnits: 1,
        totalUnits: 1,
      },
    });
  });

  it("persists retry state for retryable failures and terminal failure after the limit", async () => {
    const { service, advance } = createHarness();
    const queued = await service.enqueue({
      kind: "vision.face-analysis",
      payload: { videoId: 43 },
    });
    const worker = new DurableJobWorker(service, {
      workerId: "worker-a",
      leaseDurationMs: 30_000,
      maxRetries: 1,
      retryDelayMs: () => 5_000,
      handlers: {
        "vision.face-analysis": async () => {
          throw new Error("vision unavailable");
        },
      },
      classifyError: () => ({
        retryable: true,
        error: { code: "VISION_UNAVAILABLE", message: "vision unavailable" },
      }),
    });

    expect(await worker.runOnce()).toBe(true);
    expect(await service.get(queued.id)).toMatchObject({
      status: "retry_wait",
      retryCount: 1,
    });

    advance(5_000);
    expect(await worker.runOnce()).toBe(true);
    expect(await service.get(queued.id)).toMatchObject({
      status: "failed",
      retryCount: 1,
      lastError: { code: "VISION_UNAVAILABLE" },
    });
  });

  it("does not acknowledge work after cancellation invalidates the lease", async () => {
    const { service } = createHarness();
    const queued = await service.enqueue({
      kind: "vision.face-analysis",
      payload: { videoId: 44 },
    });
    const worker = new DurableJobWorker(service, {
      workerId: "worker-a",
      leaseDurationMs: 30_000,
      handlers: {
        "vision.face-analysis": async (job) => {
          await service.requestCancellation(job.id);
        },
      },
    });

    expect(await worker.runOnce()).toBe(true);
    expect(await service.get(queued.id)).toMatchObject({ status: "cancelled" });
  });

  it("accepts a handler that atomically completes its own durable job", async () => {
    const { service } = createHarness();
    const queued = await service.enqueue({
      kind: "vision.atomic-publication",
      payload: {},
    });
    const worker = new DurableJobWorker(service, {
      workerId: "worker-a",
      leaseDurationMs: 30_000,
      handlers: {
        "vision.atomic-publication": async (job) => {
          await service.complete({
            jobId: job.id,
            leaseToken: job.leaseToken!,
          });
        },
      },
    });

    expect(await worker.runOnce()).toBe(true);
    expect(await service.get(queued.id)).toMatchObject({ status: "completed" });
  });

  it("accepts retry state atomically settled by a domain handler", async () => {
    const { service } = createHarness();
    const queued = await service.enqueue({
      kind: "vision.content-analysis",
      payload: { runId: 1 },
    });
    const worker = new DurableJobWorker(service, {
      workerId: "worker-a",
      leaseDurationMs: 30_000,
      maxRetries: 1,
      handlers: {
        "vision.content-analysis": async (job) => {
          await service.retryAfter({
            jobId: job.id,
            leaseToken: job.leaseToken!,
            error: { code: "TRANSIENT", message: "retry later" },
            delayMs: 1_000,
          });
          throw new Error("retry later");
        },
      },
      classifyError: () => ({
        retryable: true,
        error: { code: "TRANSIENT", message: "retry later" },
      }),
    });

    expect(await worker.runOnce()).toBe(true);
    expect(await service.get(queued.id)).toMatchObject({
      status: "retry_wait",
      retryCount: 1,
      lastError: { code: "TRANSIENT" },
    });
  });

  it("fails unknown job kinds instead of leaving their lease running", async () => {
    const { service } = createHarness();
    const queued = await service.enqueue({
      kind: "vision.unknown",
      payload: {},
    });
    const worker = new DurableJobWorker(service, {
      workerId: "worker-a",
      leaseDurationMs: 30_000,
      kinds: ["vision.unknown"],
      handlers: {},
    });

    expect(await worker.runOnce()).toBe(true);
    expect(await service.get(queued.id)).toMatchObject({
      status: "failed",
      lastError: { code: "UNSUPPORTED_JOB_KIND" },
    });
  });

  it("does not claim unrelated work when no kinds or handlers are configured", async () => {
    const { service } = createHarness();
    const queued = await service.enqueue({
      kind: "vision.content-analysis",
      payload: { runId: 1 },
    });
    const worker = new DurableJobWorker(service, {
      workerId: "empty-worker",
      leaseDurationMs: 30_000,
      handlers: {},
    });

    expect(await worker.runOnce()).toBe(false);
    expect(await service.get(queued.id)).toMatchObject({ status: "queued" });
  });

  it("fails an expired poison job once crash recovery exceeds the retry budget", async () => {
    const { service, advance } = createHarness();
    const queued = await service.enqueue({
      kind: "vision.content-analysis",
      payload: { runId: 1 },
    });
    await service.claim({ workerId: "crashed-a", leaseDurationMs: 10 });
    advance(11);
    await service.claim({ workerId: "crashed-b", leaseDurationMs: 10 });
    advance(11);
    let handlerCalls = 0;
    const worker = new DurableJobWorker(service, {
      workerId: "recovery-worker",
      leaseDurationMs: 30_000,
      maxRetries: 1,
      handlers: {
        "vision.content-analysis": async () => {
          handlerCalls += 1;
        },
      },
    });

    expect(await worker.runOnce()).toBe(true);
    expect(handlerCalls).toBe(0);
    expect(await service.get(queued.id)).toMatchObject({
      status: "failed",
      retryCount: 2,
      lastError: { code: "JOB_RETRY_BUDGET_EXHAUSTED" },
    });
  });

  it("stops heartbeats when the handler has finished", async () => {
    const { service } = createHarness();
    await service.enqueue({ kind: "vision.short", payload: {} });
    let heartbeatCount = 0;
    const originalHeartbeat = service.heartbeat.bind(service);
    let markHeartbeatStarted!: () => void;
    const heartbeatStarted = new Promise<void>((resolve) => {
      markHeartbeatStarted = resolve;
    });
    let releaseHeartbeat!: () => void;
    const heartbeatMayFinish = new Promise<void>((resolve) => {
      releaseHeartbeat = resolve;
    });
    service.heartbeat = async (input) => {
      heartbeatCount += 1;
      markHeartbeatStarted();
      await heartbeatMayFinish;
      return originalHeartbeat(input);
    };
    let markHandlerFinished!: () => void;
    const handlerFinished = new Promise<void>((resolve) => {
      markHandlerFinished = resolve;
    });
    const worker = new DurableJobWorker(service, {
      workerId: "worker-a",
      leaseDurationMs: 100,
      heartbeatIntervalMs: 5,
      handlers: {
        "vision.short": async () => {
          await heartbeatStarted;
          markHandlerFinished();
        },
      },
    });

    const processing = worker.runOnce();
    await handlerFinished;
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseHeartbeat();
    await processing;
    const countAtCompletion = heartbeatCount;
    await new Promise((resolve) => setTimeout(resolve, 15));

    expect(heartbeatCount).toBe(countAtCompletion);
  });

  it("bounds shutdown when a handler ignores cancellation", async () => {
    const { service } = createHarness();
    await service.enqueue({ kind: "vision.blocked", payload: {} });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const worker = new DurableJobWorker(service, {
      workerId: "worker-a",
      leaseDurationMs: 30_000,
      stopGracePeriodMs: 10,
      pollIntervalMs: 1,
      handlers: { "vision.blocked": async () => blocked },
    });

    await worker.start();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const startedAt = Date.now();
    await worker.stop();

    expect(Date.now() - startedAt).toBeLessThan(100);
    release();
  });
});
