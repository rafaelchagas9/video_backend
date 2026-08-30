CREATE TABLE "content_analysis_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"durable_job_id" integer NOT NULL,
	"video_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"kind" text DEFAULT 'nudity' NOT NULL,
	"profile" text NOT NULL,
	"requested_categories" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"phase" text DEFAULT 'queued' NOT NULL,
	"scanned_seconds" real DEFAULT 0 NOT NULL,
	"source_duration_seconds" real NOT NULL,
	"sampled_frames" integer DEFAULT 0 NOT NULL,
	"positive_frames" integer DEFAULT 0 NOT NULL,
	"source_fingerprint" text NOT NULL,
	"analyzer_revision" text NOT NULL,
	"model_revision" text NOT NULL,
	"taxonomy_revision" text NOT NULL,
	"config_revision" text NOT NULL,
	"idempotency_key" text,
	"request_digest" text NOT NULL,
	"semantic_generation_key" text NOT NULL,
	"result_event_count" integer DEFAULT 0 NOT NULL,
	"result_bookmark_count" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"error_message" text,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"is_published" boolean DEFAULT false NOT NULL,
	"published_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_analysis_runs_kind_check" CHECK ("content_analysis_runs"."kind" = 'nudity'),
	CONSTRAINT "content_analysis_runs_profile_check" CHECK ("content_analysis_runs"."profile" IN ('balanced', 'thorough')),
	CONSTRAINT "content_analysis_runs_categories_check" CHECK (jsonb_typeof("content_analysis_runs"."requested_categories") = 'array' AND jsonb_array_length("content_analysis_runs"."requested_categories") BETWEEN 1 AND 11 AND "content_analysis_runs"."requested_categories" <@ '["BUTTOCKS_EXPOSED", "FEMALE_BREAST_EXPOSED", "FEMALE_GENITALIA_EXPOSED", "MALE_BREAST_EXPOSED", "ANUS_EXPOSED", "FEET_EXPOSED", "ARMPITS_EXPOSED", "BELLY_EXPOSED", "MALE_GENITALIA_EXPOSED", "ANUS_COVERED", "FEMALE_GENITALIA_COVERED"]'::jsonb),
	CONSTRAINT "content_analysis_runs_status_check" CHECK ("content_analysis_runs"."status" IN ('queued', 'running', 'retry_wait', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "content_analysis_runs_phase_check" CHECK ("content_analysis_runs"."phase" IN ('queued', 'extracting', 'analyzing', 'refining', 'condensing', 'publishing', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "content_analysis_runs_state_check" CHECK (("content_analysis_runs"."status" = 'queued' AND "content_analysis_runs"."phase" = 'queued') OR ("content_analysis_runs"."status" IN ('running', 'retry_wait') AND "content_analysis_runs"."phase" IN ('queued', 'extracting', 'analyzing', 'refining', 'condensing', 'publishing')) OR ("content_analysis_runs"."status" = 'completed' AND "content_analysis_runs"."phase" = 'completed') OR ("content_analysis_runs"."status" = 'failed' AND "content_analysis_runs"."phase" = 'failed') OR ("content_analysis_runs"."status" = 'cancelled' AND "content_analysis_runs"."phase" = 'cancelled')),
	CONSTRAINT "content_analysis_runs_progress_check" CHECK ("content_analysis_runs"."source_duration_seconds" > 0 AND "content_analysis_runs"."scanned_seconds" >= 0 AND "content_analysis_runs"."scanned_seconds" <= "content_analysis_runs"."source_duration_seconds" AND "content_analysis_runs"."sampled_frames" >= 0 AND "content_analysis_runs"."positive_frames" >= 0 AND "content_analysis_runs"."positive_frames" <= "content_analysis_runs"."sampled_frames" AND "content_analysis_runs"."result_event_count" >= 0 AND "content_analysis_runs"."result_bookmark_count" >= 0 AND "content_analysis_runs"."retry_count" >= 0),
	CONSTRAINT "content_analysis_runs_revision_check" CHECK (length("content_analysis_runs"."source_fingerprint") > 0 AND length("content_analysis_runs"."analyzer_revision") > 0 AND length("content_analysis_runs"."model_revision") > 0 AND length("content_analysis_runs"."taxonomy_revision") > 0 AND length("content_analysis_runs"."config_revision") > 0 AND length("content_analysis_runs"."request_digest") > 0 AND length("content_analysis_runs"."semantic_generation_key") > 0),
	CONSTRAINT "content_analysis_runs_error_check" CHECK (("content_analysis_runs"."status" IN ('retry_wait', 'failed') AND "content_analysis_runs"."error_code" IS NOT NULL AND "content_analysis_runs"."error_message" IS NOT NULL) OR ("content_analysis_runs"."status" NOT IN ('retry_wait', 'failed'))),
	CONSTRAINT "content_analysis_runs_publication_check" CHECK (("content_analysis_runs"."is_published" = true AND "content_analysis_runs"."status" = 'completed' AND "content_analysis_runs"."published_at" IS NOT NULL) OR ("content_analysis_runs"."is_published" = false AND "content_analysis_runs"."published_at" IS NULL)),
	CONSTRAINT "content_analysis_runs_terminal_timestamps_check" CHECK (("content_analysis_runs"."status" = 'cancelled' AND "content_analysis_runs"."cancelled_at" IS NOT NULL AND "content_analysis_runs"."completed_at" IS NOT NULL) OR ("content_analysis_runs"."status" IN ('completed', 'failed') AND "content_analysis_runs"."cancelled_at" IS NULL AND "content_analysis_runs"."completed_at" IS NOT NULL) OR ("content_analysis_runs"."status" IN ('queued', 'running', 'retry_wait') AND "content_analysis_runs"."cancelled_at" IS NULL AND "content_analysis_runs"."completed_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "content_analysis_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL,
	"generation_key" text NOT NULL,
	"start_seconds" real NOT NULL,
	"peak_seconds" real NOT NULL,
	"end_seconds" real NOT NULL,
	"category_summary" jsonb NOT NULL,
	"published_bookmark_id" integer,
	"is_published" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_analysis_events_interval_check" CHECK ("content_analysis_events"."start_seconds" >= 0 AND "content_analysis_events"."start_seconds" <= "content_analysis_events"."peak_seconds" AND "content_analysis_events"."peak_seconds" <= "content_analysis_events"."end_seconds"),
	CONSTRAINT "content_analysis_events_categories_check" CHECK (jsonb_typeof("content_analysis_events"."category_summary") = 'array' AND jsonb_array_length("content_analysis_events"."category_summary") > 0),
	CONSTRAINT "content_analysis_events_generation_key_check" CHECK (length("content_analysis_events"."generation_key") > 0),
	CONSTRAINT "content_analysis_events_publication_check" CHECK ("content_analysis_events"."is_published" = false OR "content_analysis_events"."published_bookmark_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "content_analysis_runs" ADD CONSTRAINT "content_analysis_runs_durable_job_id_durable_jobs_id_fk" FOREIGN KEY ("durable_job_id") REFERENCES "public"."durable_jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_analysis_runs" ADD CONSTRAINT "content_analysis_runs_video_id_videos_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."videos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_analysis_runs" ADD CONSTRAINT "content_analysis_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_analysis_events" ADD CONSTRAINT "content_analysis_events_run_id_content_analysis_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."content_analysis_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_analysis_events" ADD CONSTRAINT "content_analysis_events_published_bookmark_id_bookmarks_id_fk" FOREIGN KEY ("published_bookmark_id") REFERENCES "public"."bookmarks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "content_analysis_runs_durable_job_unique" ON "content_analysis_runs" USING btree ("durable_job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "content_analysis_runs_active_semantic_unique" ON "content_analysis_runs" USING btree ("semantic_generation_key") WHERE "content_analysis_runs"."status" IN ('queued', 'running', 'retry_wait');--> statement-breakpoint
CREATE UNIQUE INDEX "content_analysis_runs_user_idempotency_unique" ON "content_analysis_runs" USING btree ("user_id","idempotency_key") WHERE "content_analysis_runs"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "content_analysis_runs_published_generation_unique" ON "content_analysis_runs" USING btree ("video_id","user_id","kind") WHERE "content_analysis_runs"."is_published" = true;--> statement-breakpoint
CREATE INDEX "idx_content_analysis_runs_owner" ON "content_analysis_runs" USING btree ("user_id","id");--> statement-breakpoint
CREATE INDEX "idx_content_analysis_runs_video_history" ON "content_analysis_runs" USING btree ("video_id","user_id","kind","created_at");--> statement-breakpoint
CREATE INDEX "idx_content_analysis_runs_status" ON "content_analysis_runs" USING btree ("status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "content_analysis_events_run_generation_unique" ON "content_analysis_events" USING btree ("run_id","generation_key");--> statement-breakpoint
CREATE UNIQUE INDEX "content_analysis_events_published_bookmark_unique" ON "content_analysis_events" USING btree ("published_bookmark_id") WHERE "content_analysis_events"."published_bookmark_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_content_analysis_events_run_timeline" ON "content_analysis_events" USING btree ("run_id","start_seconds","id");--> statement-breakpoint
ALTER TABLE "bookmarks" ADD CONSTRAINT "bookmarks_analysis_run_id_content_analysis_runs_id_fk" FOREIGN KEY ("analysis_run_id") REFERENCES "public"."content_analysis_runs"("id") ON DELETE restrict ON UPDATE no action;