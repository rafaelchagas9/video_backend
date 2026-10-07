CREATE TABLE "recording_clip_feedback" (
	"id" serial PRIMARY KEY NOT NULL,
	"video_id" integer NOT NULL,
	"analyzed_at" timestamp NOT NULL,
	"clip_id" text NOT NULL,
	"channel" text,
	"detector" text NOT NULL,
	"verdict" text NOT NULL,
	"added" boolean DEFAULT false NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"start_seconds" double precision NOT NULL,
	"end_seconds" double precision NOT NULL,
	"detected_start" double precision,
	"detected_end" double precision,
	"peak_seconds" double precision NOT NULL,
	"score" double precision NOT NULL,
	"label" text NOT NULL,
	"recording_seconds" double precision,
	"rendered" boolean DEFAULT false NOT NULL,
	"recording_discarded" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "recording_clip_feedback_clip" ON "recording_clip_feedback" USING btree ("video_id","analyzed_at","clip_id");