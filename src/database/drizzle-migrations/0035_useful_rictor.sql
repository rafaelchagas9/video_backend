CREATE TABLE "durable_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"worker_id" text,
	"lease_token" text,
	"lease_expires_at" timestamp with time zone,
	"checkpoint" jsonb,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_error" jsonb,
	"started_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	CONSTRAINT "durable_jobs_status_check" CHECK ("durable_jobs"."status" IN ('queued', 'running', 'retry_wait', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "durable_jobs_attempt_check" CHECK ("durable_jobs"."attempt" >= 0 AND "durable_jobs"."retry_count" >= 0),
	CONSTRAINT "durable_jobs_lease_check" CHECK (("durable_jobs"."status" = 'running' AND "durable_jobs"."worker_id" IS NOT NULL AND "durable_jobs"."lease_token" IS NOT NULL AND "durable_jobs"."lease_expires_at" IS NOT NULL) OR ("durable_jobs"."status" <> 'running' AND "durable_jobs"."worker_id" IS NULL AND "durable_jobs"."lease_token" IS NULL AND "durable_jobs"."lease_expires_at" IS NULL))
);
--> statement-breakpoint
CREATE INDEX "idx_durable_jobs_queued_claim" ON "durable_jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "idx_durable_jobs_retry_claim" ON "durable_jobs" USING btree ("status","next_attempt_at","created_at");--> statement-breakpoint
CREATE INDEX "idx_durable_jobs_expired_lease" ON "durable_jobs" USING btree ("status","lease_expires_at","created_at");--> statement-breakpoint
CREATE INDEX "idx_durable_jobs_kind_status" ON "durable_jobs" USING btree ("kind","status");