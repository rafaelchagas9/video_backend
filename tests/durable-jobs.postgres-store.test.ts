import { describe, expect, it } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  PostgresDurableJobStore,
  type PostgresDurableJobExecutor,
} from "@/modules/durable-jobs";

class RecordingExecutor implements PostgresDurableJobExecutor {
  readonly queries: SQL[] = [];

  constructor(private readonly responses: Record<string, unknown>[][]) {}

  async execute<Row extends Record<string, unknown>>(
    query: SQL
  ): Promise<Row[]> {
    this.queries.push(query);
    return (this.responses.shift() ?? []) as Row[];
  }
}

function sqlText(query: SQL): string {
  return new PgDialect()
    .sqlToQuery(query)
    .sql.replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function expectSerializedTimestamps(queries: SQL[]): void {
  const dialect = new PgDialect();
  for (const query of queries) {
    expect(
      dialect.sqlToQuery(query).params.some((value) => value instanceof Date)
    ).toBe(false);
  }
}

function persistedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    kind: "vision.face-analysis",
    payload: { videoId: 42 },
    status: "queued",
    attempt: 0,
    workerId: null,
    leaseToken: null,
    leaseExpiresAt: null,
    checkpoint: null,
    retryCount: 0,
    nextAttemptAt: null,
    lastError: null,
    startedAt: null,
    heartbeatAt: null,
    createdAt: new Date("2026-08-28T12:00:00.000Z"),
    updatedAt: new Date("2026-08-28T12:00:00.000Z"),
    completedAt: null,
    cancelledAt: null,
    ...overrides,
  };
}

describe("PostgresDurableJobStore", () => {
  it("loads a persisted job by id", async () => {
    const executor = new RecordingExecutor([[persistedRow()]]);
    const store = new PostgresDurableJobStore(executor);

    expect(await store.get(7)).toMatchObject({ id: 7, status: "queued" });
    const query = sqlText(executor.queries[0]!);
    expect(query).toContain('from "durable_jobs" as jobs');
    expect(query).toContain("where jobs.id =");
  });

  it("enqueues JSON payload and maps the returned PostgreSQL row", async () => {
    const executor = new RecordingExecutor([[persistedRow()]]);
    const store = new PostgresDurableJobStore(executor);

    const job = await store.enqueue(
      { kind: "vision.face-analysis", payload: { videoId: 42 } },
      new Date("2026-08-28T12:00:00.000Z")
    );

    expect(job).toMatchObject({
      id: 7,
      kind: "vision.face-analysis",
      payload: { videoId: 42 },
      status: "queued",
      retryCount: 0,
      startedAt: null,
      heartbeatAt: null,
    });
    expect(sqlText(executor.queries[0]!)).toContain(
      'insert into "durable_jobs"'
    );
    expect(sqlText(executor.queries[0]!)).toContain("returning");
    expectSerializedTimestamps(executor.queries);
  });

  it("claims one due job atomically with row locking", async () => {
    const executor = new RecordingExecutor([
      [
        persistedRow({
          status: "running",
          attempt: 2,
          workerId: "worker-b",
          leaseToken: "lease-2",
          leaseExpiresAt: new Date("2026-08-28T12:01:00.000Z"),
          startedAt: new Date("2026-08-28T11:50:00.000Z"),
          heartbeatAt: new Date("2026-08-28T12:00:00.000Z"),
        }),
      ],
    ]);
    const store = new PostgresDurableJobStore(executor);

    const claimed = await store.claim({
      workerId: "worker-b",
      leaseToken: "lease-2",
      leaseExpiresAt: new Date("2026-08-28T12:01:00.000Z"),
      now: new Date("2026-08-28T12:00:00.000Z"),
      kinds: ["vision.face-analysis"],
    });

    expect(claimed).toMatchObject({
      id: 7,
      status: "running",
      attempt: 2,
      workerId: "worker-b",
      leaseToken: "lease-2",
    });
    const query = sqlText(executor.queries[0]!);
    expect(query).toContain("for update skip locked");
    expect(query).toContain("candidate as");
    expect(query).toContain('update "durable_jobs" as jobs');
    expect(query).toContain("jobs.attempt + 1");
    expect(query).toContain("clock_timestamp()");
    expect(query).toContain("retry_count = jobs.retry_count + case");
    expectSerializedTimestamps(executor.queries);
  });

  it("uses the PostgreSQL clock for lease-bound transitions", async () => {
    const running = persistedRow({
      status: "running",
      workerId: "worker-a",
      leaseToken: "lease-1",
      leaseExpiresAt: new Date("2026-08-28T12:01:00.000Z"),
    });
    const executor = new RecordingExecutor([
      [running],
      [running],
      [persistedRow({ status: "retry_wait" })],
      [persistedRow({ status: "completed" })],
      [persistedRow({ status: "failed" })],
      [persistedRow({ status: "cancelled" })],
    ]);
    const store = new PostgresDurableJobStore(executor);
    const lease = { jobId: 7, leaseToken: "lease-1" };
    const processClock = new Date("2099-01-01T00:00:00.000Z");

    await store.heartbeat({
      ...lease,
      leaseExpiresAt: new Date("2099-01-01T00:01:00.000Z"),
      now: processClock,
    });
    await store.checkpoint({
      ...lease,
      checkpoint: { stage: "analyzing", completedUnits: 1 },
      now: processClock,
    });
    await store.retry({
      ...lease,
      error: { code: "TRANSIENT", message: "retry" },
      nextAttemptAt: new Date("2099-01-01T00:00:05.000Z"),
      now: processClock,
    });
    await store.complete({ ...lease, now: processClock });
    await store.fail({
      ...lease,
      error: { code: "FAILED", message: "failed" },
      now: processClock,
    });
    await store.requestCancellation(7, processClock);

    for (const query of executor.queries) {
      expect(sqlText(query)).toContain("clock_timestamp()");
    }
  });

  it("guards every owner mutation by running status, lease token, and expiry", async () => {
    const running = persistedRow({
      status: "running",
      workerId: "worker-a",
      leaseToken: "lease-1",
      leaseExpiresAt: new Date("2026-08-28T12:01:00.000Z"),
    });
    const executor = new RecordingExecutor([
      [running],
      [running],
      [
        persistedRow({
          status: "retry_wait",
          retryCount: 1,
          nextAttemptAt: new Date("2026-08-28T12:05:00.000Z"),
        }),
      ],
      [persistedRow({ status: "completed" })],
      [
        persistedRow({
          status: "failed",
          lastError: { code: "INVALID_VIDEO", message: "invalid stream" },
        }),
      ],
    ]);
    const store = new PostgresDurableJobStore(executor);
    const lease = { jobId: 7, leaseToken: "lease-1" };
    const now = new Date("2026-08-28T12:00:00.000Z");

    await store.heartbeat({
      ...lease,
      leaseExpiresAt: new Date("2026-08-28T12:02:00.000Z"),
      now,
    });
    await store.checkpoint({
      ...lease,
      checkpoint: { stage: "analyzing", completedUnits: 5 },
      now,
    });
    await store.retry({
      ...lease,
      error: { code: "VISION_UNAVAILABLE", message: "service unavailable" },
      nextAttemptAt: new Date("2026-08-28T12:05:00.000Z"),
      now,
    });
    await store.complete({ ...lease, now });
    await store.fail({
      ...lease,
      error: { code: "INVALID_VIDEO", message: "invalid stream" },
      now,
    });

    expect(executor.queries).toHaveLength(5);
    for (const query of executor.queries) {
      const statement = sqlText(query);
      expect(statement).toContain("status = 'running'");
      expect(statement).toContain("lease_token =");
      expect(statement).toContain("lease_expires_at >");
      expect(statement).toContain("returning");
    }
    expectSerializedTimestamps(executor.queries);
  });

  it("cancels active jobs idempotently and clears their lease", async () => {
    const executor = new RecordingExecutor([
      [
        persistedRow({
          status: "cancelled",
          cancelledAt: new Date("2026-08-28T12:00:00.000Z"),
          completedAt: new Date("2026-08-28T12:00:00.000Z"),
        }),
      ],
    ]);
    const store = new PostgresDurableJobStore(executor);

    expect(
      await store.requestCancellation(7, new Date("2026-08-28T12:00:00.000Z"))
    ).toMatchObject({ status: "cancelled", leaseToken: null, workerId: null });

    const query = sqlText(executor.queries[0]!);
    expect(query).toContain("status in ('queued', 'running', 'retry_wait')");
    expect(query).toContain("lease_token = null");
    expect(query).toContain("union all");
    expect(query).toContain("status = 'cancelled'");
    expectSerializedTimestamps(executor.queries);
  });
});
