import { describe, expect, it } from "bun:test";
import {
  DurableJobsService,
  InMemoryDurableJobStore,
} from "@/modules/durable-jobs";

function createHarness() {
  let now = new Date("2026-08-28T12:00:00.000Z");
  let tokenSequence = 0;
  const store = new InMemoryDurableJobStore();
  const service = new DurableJobsService(store, {
    now: () => now,
    createLeaseToken: () => `lease-${++tokenSequence}`,
  });

  return {
    service,
    advance(milliseconds: number) {
      now = new Date(now.getTime() + milliseconds);
    },
  };
}

describe("durable jobs", () => {
  it("reclaims an expired lease and rejects completion by the previous worker", async () => {
    const { service, advance } = createHarness();
    const queued = await service.enqueue({
      kind: "vision.face-analysis",
      payload: { videoId: 42 },
    });

    const firstClaim = await service.claim({
      workerId: "worker-a",
      leaseDurationMs: 30_000,
    });

    expect(firstClaim).toMatchObject({
      id: queued.id,
      status: "running",
      workerId: "worker-a",
      leaseToken: "lease-1",
      attempt: 1,
    });

    advance(30_001);

    const secondClaim = await service.claim({
      workerId: "worker-b",
      leaseDurationMs: 30_000,
    });

    expect(secondClaim).toMatchObject({
      id: queued.id,
      status: "running",
      workerId: "worker-b",
      leaseToken: "lease-2",
      attempt: 2,
      retryCount: 1,
    });
    expect(
      await service.complete({ jobId: queued.id, leaseToken: "lease-1" })
    ).toBeNull();
    expect(
      await service.complete({ jobId: queued.id, leaseToken: "lease-2" })
    ).toMatchObject({ status: "completed", workerId: null, leaseToken: null });
  });

  it("charges every expired lease reclaim to the persisted retry budget", async () => {
    const { service, advance } = createHarness();
    const queued = await service.enqueue({
      kind: "vision.content-analysis",
      payload: { runId: 7 },
    });

    await service.claim({ workerId: "worker-a", leaseDurationMs: 10 });
    advance(11);
    expect(
      await service.claim({ workerId: "worker-b", leaseDurationMs: 10 })
    ).toMatchObject({ id: queued.id, attempt: 2, retryCount: 1 });

    advance(11);
    expect(
      await service.claim({ workerId: "worker-c", leaseDurationMs: 10 })
    ).toMatchObject({ id: queued.id, attempt: 3, retryCount: 2 });
  });

  it("renews a valid lease and persists checkpoints only for its owner", async () => {
    const { service, advance } = createHarness();
    const queued = await service.enqueue({
      kind: "vision.face-analysis",
      payload: { videoId: 43 },
    });
    await service.claim({ workerId: "worker-a", leaseDurationMs: 30_000 });

    advance(20_000);
    const heartbeat = await service.heartbeat({
      jobId: queued.id,
      leaseToken: "lease-1",
      leaseDurationMs: 30_000,
    });
    expect(heartbeat?.leaseExpiresAt?.toISOString()).toBe(
      "2026-08-28T12:00:50.000Z"
    );

    expect(
      await service.checkpoint({
        jobId: queued.id,
        leaseToken: "not-the-owner",
        checkpoint: { stage: "analyzing", completedUnits: 7, totalUnits: 10 },
      })
    ).toBeNull();
    expect(
      await service.checkpoint({
        jobId: queued.id,
        leaseToken: "lease-1",
        checkpoint: { stage: "analyzing", completedUnits: 7, totalUnits: 10 },
      })
    ).toMatchObject({
      checkpoint: { stage: "analyzing", completedUnits: 7, totalUnits: 10 },
    });

    advance(15_000);
    expect(
      await service.claim({ workerId: "worker-b", leaseDurationMs: 30_000 })
    ).toBeNull();
  });

  it("does not resurrect a cancelled running job", async () => {
    const { service, advance } = createHarness();
    const queued = await service.enqueue({
      kind: "vision.face-analysis",
      payload: { videoId: 44 },
    });
    await service.claim({ workerId: "worker-a", leaseDurationMs: 30_000 });

    expect(await service.requestCancellation(queued.id)).toMatchObject({
      status: "cancelled",
      workerId: null,
      leaseToken: null,
    });
    expect(
      await service.complete({ jobId: queued.id, leaseToken: "lease-1" })
    ).toBeNull();

    advance(60_000);
    expect(
      await service.claim({ workerId: "worker-b", leaseDurationMs: 30_000 })
    ).toBeNull();
  });

  it("persists retry state and only reclaims the job when it becomes due", async () => {
    const { service, advance } = createHarness();
    const queued = await service.enqueue({
      kind: "vision.face-analysis",
      payload: { videoId: 45 },
    });
    await service.claim({ workerId: "worker-a", leaseDurationMs: 30_000 });

    const retried = await service.retry({
      jobId: queued.id,
      leaseToken: "lease-1",
      error: { code: "VISION_UNAVAILABLE", message: "service unavailable" },
      nextAttemptAt: new Date("2026-08-28T12:05:00.000Z"),
    });
    expect(retried).toMatchObject({
      status: "retry_wait",
      retryCount: 1,
      workerId: null,
      leaseToken: null,
      lastError: {
        code: "VISION_UNAVAILABLE",
        message: "service unavailable",
      },
    });
    expect(retried?.nextAttemptAt?.toISOString()).toBe(
      "2026-08-28T12:05:00.000Z"
    );

    advance(299_999);
    expect(
      await service.claim({ workerId: "worker-b", leaseDurationMs: 30_000 })
    ).toBeNull();

    advance(1);
    expect(
      await service.claim({ workerId: "worker-b", leaseDurationMs: 30_000 })
    ).toMatchObject({
      status: "running",
      retryCount: 1,
      attempt: 2,
      workerId: "worker-b",
      leaseToken: "lease-3",
    });
  });

  it("persists terminal failure only when the current lease owns the job", async () => {
    const { service } = createHarness();
    const queued = await service.enqueue({
      kind: "vision.face-analysis",
      payload: { videoId: 46 },
    });
    await service.claim({ workerId: "worker-a", leaseDurationMs: 30_000 });

    expect(
      await service.fail({
        jobId: queued.id,
        leaseToken: "not-the-owner",
        error: { code: "INVALID_VIDEO", message: "unsupported stream" },
      })
    ).toBeNull();
    expect(
      await service.fail({
        jobId: queued.id,
        leaseToken: "lease-1",
        error: { code: "INVALID_VIDEO", message: "unsupported stream" },
      })
    ).toMatchObject({
      status: "failed",
      workerId: null,
      leaseToken: null,
      lastError: { code: "INVALID_VIDEO", message: "unsupported stream" },
    });
    expect(
      await service.claim({ workerId: "worker-b", leaseDurationMs: 30_000 })
    ).toBeNull();
  });
});
