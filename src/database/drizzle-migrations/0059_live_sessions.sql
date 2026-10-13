CREATE TABLE "recorder_live_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"username" text NOT NULL,
	"site" text NOT NULL,
	"started_at" timestamp NOT NULL,
	"last_seen_at" timestamp NOT NULL,
	"ended_at" timestamp,
	"capture" text NOT NULL,
	"threshold" double precision,
	"status" text DEFAULT 'live' NOT NULL,
	"gender" text,
	"titles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"viewers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"peak_viewers" integer DEFAULT 0 NOT NULL,
	"clips" jsonb,
	"job_id" integer,
	"output_video_id" integer,
	"error" text,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "recorder_autopilot_channels" ADD COLUMN "capture" text DEFAULT 'training' NOT NULL;--> statement-breakpoint
ALTER TABLE "recorder_autopilot_channels" ADD COLUMN "highlight_threshold" double precision;--> statement-breakpoint
CREATE UNIQUE INDEX "recorder_live_sessions_open" ON "recorder_live_sessions" USING btree ("channel_id") WHERE "recorder_live_sessions"."ended_at" IS NULL;--> statement-breakpoint
UPDATE "recorder_autopilot_channels" SET "capture" = 'manual' WHERE "managed" = false;
