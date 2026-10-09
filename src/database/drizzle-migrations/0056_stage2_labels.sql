CREATE TABLE "recording_label_tasks" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"batch" text NOT NULL,
	"video_id" integer NOT NULL,
	"start_seconds" double precision NOT NULL,
	"end_seconds" double precision NOT NULL,
	"stratum" text NOT NULL,
	"weight" double precision,
	"position" integer DEFAULT 0 NOT NULL,
	"channel" text,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"answer" text,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"answered_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "recording_clip_feedback" ADD COLUMN "refinement" text;--> statement-breakpoint
ALTER TABLE "recording_clip_feedback" ADD COLUMN "refinement_at" timestamp;--> statement-breakpoint
ALTER TABLE "recording_clip_feedback" ADD COLUMN "baseline_rank" integer;--> statement-breakpoint
ALTER TABLE "recording_clip_feedback" ADD COLUMN "baseline_score" double precision;--> statement-breakpoint
ALTER TABLE "recording_clip_feedback" ADD COLUMN "review_order" text;--> statement-breakpoint
CREATE UNIQUE INDEX "recording_label_tasks_item" ON "recording_label_tasks" USING btree ("kind","batch","video_id","start_seconds");