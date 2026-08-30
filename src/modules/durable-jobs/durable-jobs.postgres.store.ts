import { sql, type SQL } from "drizzle-orm";
import { durableJobsTable } from "@/database/schema/durable-jobs.schema";
import type {
  CheckpointDurableJobInput,
  DurableJob,
  DurableJobCheckpoint,
  DurableJobError,
  DurableJobStatus,
  EnqueueDurableJobInput,
  FailDurableJobInput,
  LeaseMutationInput,
  RetryDurableJobInput,
} from "./durable-jobs.types";
import type { DurableJobStore } from "./durable-jobs.store";

export interface PostgresDurableJobExecutor {
  execute<Row extends Record<string, unknown>>(query: SQL): Promise<Row[]>;
}

type DurableJobRow = Record<string, unknown>;

const RETURNING_COLUMNS = sql.raw(`
  id,
  kind,
  payload,
  status,
  attempt,
  worker_id AS "workerId",
  lease_token AS "leaseToken",
  lease_expires_at AS "leaseExpiresAt",
  checkpoint,
  retry_count AS "retryCount",
  next_attempt_at AS "nextAttemptAt",
  last_error AS "lastError",
  started_at AS "startedAt",
  heartbeat_at AS "heartbeatAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt",
  completed_at AS "completedAt",
  cancelled_at AS "cancelledAt"
`);

const RETURNING_JOB_COLUMNS = sql.raw(`
  jobs.id AS id,
  jobs.kind AS kind,
  jobs.payload AS payload,
  jobs.status AS status,
  jobs.attempt AS attempt,
  jobs.worker_id AS "workerId",
  jobs.lease_token AS "leaseToken",
  jobs.lease_expires_at AS "leaseExpiresAt",
  jobs.checkpoint AS checkpoint,
  jobs.retry_count AS "retryCount",
  jobs.next_attempt_at AS "nextAttemptAt",
  jobs.last_error AS "lastError",
  jobs.started_at AS "startedAt",
  jobs.heartbeat_at AS "heartbeatAt",
  jobs.created_at AS "createdAt",
  jobs.updated_at AS "updatedAt",
  jobs.completed_at AS "completedAt",
  jobs.cancelled_at AS "cancelledAt"
`);

function requiredDate(value: unknown, field: string): Date {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`Invalid ${field} returned by durable job store`);
  }
  return date;
}

function optionalDate(value: unknown, field: string): Date | null {
  return value === null || value === undefined
    ? null
    : requiredDate(value, field);
}

function durationBetween(later: Date, earlier: Date, field: string): number {
  const milliseconds = later.getTime() - earlier.getTime();
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    throw new RangeError(`${field} must be a finite non-negative duration`);
  }
  return milliseconds;
}

function mapRow(row: DurableJobRow): DurableJob {
  return {
    id: Number(row.id),
    kind: String(row.kind),
    payload: row.payload as Record<string, unknown>,
    status: row.status as DurableJobStatus,
    attempt: Number(row.attempt),
    workerId: row.workerId === null ? null : String(row.workerId),
    leaseToken: row.leaseToken === null ? null : String(row.leaseToken),
    leaseExpiresAt: optionalDate(row.leaseExpiresAt, "leaseExpiresAt"),
    checkpoint: row.checkpoint as DurableJobCheckpoint | null,
    retryCount: Number(row.retryCount),
    nextAttemptAt: optionalDate(row.nextAttemptAt, "nextAttemptAt"),
    lastError: row.lastError as DurableJobError | null,
    startedAt: optionalDate(row.startedAt, "startedAt"),
    heartbeatAt: optionalDate(row.heartbeatAt, "heartbeatAt"),
    createdAt: requiredDate(row.createdAt, "createdAt"),
    updatedAt: requiredDate(row.updatedAt, "updatedAt"),
    completedAt: optionalDate(row.completedAt, "completedAt"),
    cancelledAt: optionalDate(row.cancelledAt, "cancelledAt"),
  };
}

export class PostgresDurableJobStore implements DurableJobStore {
  constructor(private readonly executor: PostgresDurableJobExecutor) {}

  async get(jobId: number): Promise<DurableJob | null> {
    const rows = await this.executor.execute<DurableJobRow>(sql`
      SELECT ${RETURNING_JOB_COLUMNS}
      FROM ${durableJobsTable} AS jobs
      WHERE jobs.id = ${jobId}
      LIMIT 1
    `);
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async enqueue(
    input: EnqueueDurableJobInput,
    _now: Date
  ): Promise<DurableJob> {
    const rows = await this.executor.execute<DurableJobRow>(sql`
      INSERT INTO ${durableJobsTable} (kind, payload, status, created_at, updated_at)
      VALUES (${input.kind}, ${JSON.stringify(input.payload)}::jsonb, 'queued', clock_timestamp(), clock_timestamp())
      RETURNING ${RETURNING_COLUMNS}
    `);
    const row = rows[0];
    if (!row) throw new Error("Durable job insert returned no row");
    return mapRow(row);
  }

  async claim(input: {
    workerId: string;
    leaseToken: string;
    leaseExpiresAt: Date;
    now: Date;
    kinds?: string[];
  }): Promise<DurableJob | null> {
    if (input.kinds?.length === 0) return null;
    const leaseDurationMs = durationBetween(
      input.leaseExpiresAt,
      input.now,
      "lease duration"
    );
    const kindFilter = input.kinds
      ? sql`AND kind IN (${sql.join(
          input.kinds.map((kind) => sql`${kind}`),
          sql`, `
        )})`
      : sql.empty();
    const rows = await this.executor.execute<DurableJobRow>(sql`
      WITH db_clock AS (
        SELECT clock_timestamp() AS now
      ), candidate AS (
        SELECT id
        FROM ${durableJobsTable}, db_clock
        WHERE (
          status = 'queued'
          OR (status = 'retry_wait' AND next_attempt_at <= db_clock.now)
          OR (status = 'running' AND lease_expires_at <= db_clock.now)
        )
        ${kindFilter}
        ORDER BY created_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE ${durableJobsTable} AS jobs
      SET
        status = 'running',
        attempt = jobs.attempt + 1,
        retry_count = jobs.retry_count + CASE WHEN jobs.status = 'running' THEN 1 ELSE 0 END,
        worker_id = ${input.workerId},
        lease_token = ${input.leaseToken},
        lease_expires_at = db_clock.now + ${leaseDurationMs} * INTERVAL '1 millisecond',
        next_attempt_at = NULL,
        started_at = COALESCE(jobs.started_at, db_clock.now),
        heartbeat_at = db_clock.now,
        updated_at = db_clock.now
      FROM candidate, db_clock
      WHERE jobs.id = candidate.id
      RETURNING ${RETURNING_JOB_COLUMNS}
    `);
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async heartbeat(
    input: LeaseMutationInput & { leaseExpiresAt: Date; now: Date }
  ): Promise<DurableJob | null> {
    const leaseDurationMs = durationBetween(
      input.leaseExpiresAt,
      input.now,
      "lease duration"
    );
    return this.executeLeaseMutation(sql`
      WITH db_clock AS (SELECT clock_timestamp() AS now)
      UPDATE ${durableJobsTable} AS jobs
      SET
        lease_expires_at = db_clock.now + ${leaseDurationMs} * INTERVAL '1 millisecond',
        heartbeat_at = db_clock.now,
        updated_at = db_clock.now
      FROM db_clock
      WHERE jobs.id = ${input.jobId}
        AND jobs.status = 'running'
        AND jobs.lease_token = ${input.leaseToken}
        AND jobs.lease_expires_at > db_clock.now
      RETURNING ${RETURNING_JOB_COLUMNS}
    `);
  }

  async checkpoint(
    input: CheckpointDurableJobInput & { now: Date }
  ): Promise<DurableJob | null> {
    return this.executeLeaseMutation(sql`
      WITH db_clock AS (SELECT clock_timestamp() AS now)
      UPDATE ${durableJobsTable} AS jobs
      SET
        checkpoint = ${JSON.stringify(input.checkpoint)}::jsonb,
        updated_at = db_clock.now
      FROM db_clock
      WHERE jobs.id = ${input.jobId}
        AND jobs.status = 'running'
        AND jobs.lease_token = ${input.leaseToken}
        AND jobs.lease_expires_at > db_clock.now
      RETURNING ${RETURNING_JOB_COLUMNS}
    `);
  }

  async retry(
    input: RetryDurableJobInput & { now: Date }
  ): Promise<DurableJob | null> {
    const retryDelayMs = durationBetween(
      input.nextAttemptAt,
      input.now,
      "retry delay"
    );
    return this.executeLeaseMutation(sql`
      WITH db_clock AS (SELECT clock_timestamp() AS now)
      UPDATE ${durableJobsTable} AS jobs
      SET
        status = 'retry_wait',
        retry_count = jobs.retry_count + 1,
        next_attempt_at = db_clock.now + ${retryDelayMs} * INTERVAL '1 millisecond',
        last_error = ${JSON.stringify(input.error)}::jsonb,
        worker_id = NULL,
        lease_token = NULL,
        lease_expires_at = NULL,
        updated_at = db_clock.now
      FROM db_clock
      WHERE jobs.id = ${input.jobId}
        AND jobs.status = 'running'
        AND jobs.lease_token = ${input.leaseToken}
        AND jobs.lease_expires_at > db_clock.now
      RETURNING ${RETURNING_JOB_COLUMNS}
    `);
  }

  async requestCancellation(
    jobId: number,
    _now: Date
  ): Promise<DurableJob | null> {
    const rows = await this.executor.execute<DurableJobRow>(sql`
      WITH db_clock AS (SELECT clock_timestamp() AS now), cancelled AS (
        UPDATE ${durableJobsTable} AS jobs
        SET
          status = 'cancelled',
          worker_id = NULL,
          lease_token = NULL,
          lease_expires_at = NULL,
          next_attempt_at = NULL,
          cancelled_at = db_clock.now,
          completed_at = db_clock.now,
          updated_at = db_clock.now
        FROM db_clock
        WHERE jobs.id = ${jobId}
          AND jobs.status IN ('queued', 'running', 'retry_wait')
        RETURNING ${RETURNING_JOB_COLUMNS}
      )
      SELECT * FROM cancelled
      UNION ALL
      SELECT ${RETURNING_JOB_COLUMNS}
      FROM ${durableJobsTable} AS jobs
      WHERE jobs.id = ${jobId}
        AND jobs.status = 'cancelled'
        AND NOT EXISTS (SELECT 1 FROM cancelled)
      LIMIT 1
    `);
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async complete(
    input: LeaseMutationInput & { now: Date }
  ): Promise<DurableJob | null> {
    return this.executeLeaseMutation(sql`
      WITH db_clock AS (SELECT clock_timestamp() AS now)
      UPDATE ${durableJobsTable} AS jobs
      SET
        status = 'completed',
        worker_id = NULL,
        lease_token = NULL,
        lease_expires_at = NULL,
        completed_at = db_clock.now,
        updated_at = db_clock.now
      FROM db_clock
      WHERE jobs.id = ${input.jobId}
        AND jobs.status = 'running'
        AND jobs.lease_token = ${input.leaseToken}
        AND jobs.lease_expires_at > db_clock.now
      RETURNING ${RETURNING_JOB_COLUMNS}
    `);
  }

  async fail(
    input: FailDurableJobInput & { now: Date }
  ): Promise<DurableJob | null> {
    return this.executeLeaseMutation(sql`
      WITH db_clock AS (SELECT clock_timestamp() AS now)
      UPDATE ${durableJobsTable} AS jobs
      SET
        status = 'failed',
        last_error = ${JSON.stringify(input.error)}::jsonb,
        worker_id = NULL,
        lease_token = NULL,
        lease_expires_at = NULL,
        next_attempt_at = NULL,
        completed_at = db_clock.now,
        updated_at = db_clock.now
      FROM db_clock
      WHERE jobs.id = ${input.jobId}
        AND jobs.status = 'running'
        AND jobs.lease_token = ${input.leaseToken}
        AND jobs.lease_expires_at > db_clock.now
      RETURNING ${RETURNING_JOB_COLUMNS}
    `);
  }

  private async executeLeaseMutation(query: SQL): Promise<DurableJob | null> {
    const rows = await this.executor.execute<DurableJobRow>(query);
    return rows[0] ? mapRow(rows[0]) : null;
  }
}

export async function createPostgresDurableJobStore(): Promise<PostgresDurableJobStore> {
  const { db } = await import("@/config/drizzle");
  const executor: PostgresDurableJobExecutor = {
    async execute<Row extends Record<string, unknown>>(query: SQL) {
      const rows = await db.execute<Row>(query);
      return Array.from(rows) as Row[];
    },
  };
  return new PostgresDurableJobStore(executor);
}
