import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const durableJobsTable = pgTable(
  "durable_jobs",
  {
    id: serial("id").primaryKey(),
    kind: text("kind").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: text("status").default("queued").notNull(),
    attempt: integer("attempt").default(0).notNull(),
    workerId: text("worker_id"),
    leaseToken: text("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    checkpoint: jsonb("checkpoint").$type<Record<string, unknown>>(),
    retryCount: integer("retry_count").default(0).notNull(),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    lastError: jsonb("last_error").$type<Record<string, unknown>>(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  },
  (table) => ({
    queuedClaimIdx: index("idx_durable_jobs_queued_claim").on(
      table.status,
      table.createdAt
    ),
    retryClaimIdx: index("idx_durable_jobs_retry_claim").on(
      table.status,
      table.nextAttemptAt,
      table.createdAt
    ),
    expiredLeaseIdx: index("idx_durable_jobs_expired_lease").on(
      table.status,
      table.leaseExpiresAt,
      table.createdAt
    ),
    kindStatusIdx: index("idx_durable_jobs_kind_status").on(
      table.kind,
      table.status
    ),
    statusCheck: check(
      "durable_jobs_status_check",
      sql`${table.status} IN ('queued', 'running', 'retry_wait', 'completed', 'failed', 'cancelled')`
    ),
    attemptCheck: check(
      "durable_jobs_attempt_check",
      sql`${table.attempt} >= 0 AND ${table.retryCount} >= 0`
    ),
    leaseCheck: check(
      "durable_jobs_lease_check",
      sql`(${table.status} = 'running' AND ${table.workerId} IS NOT NULL AND ${table.leaseToken} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL) OR (${table.status} <> 'running' AND ${table.workerId} IS NULL AND ${table.leaseToken} IS NULL AND ${table.leaseExpiresAt} IS NULL)`
    ),
  })
);

export type DurableJobRecord = typeof durableJobsTable.$inferSelect;
export type NewDurableJobRecord = typeof durableJobsTable.$inferInsert;
