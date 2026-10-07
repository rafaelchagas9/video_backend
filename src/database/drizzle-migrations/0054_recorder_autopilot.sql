CREATE TABLE "recorder_autopilot_channels" (
	"channel_id" text PRIMARY KEY NOT NULL,
	"managed" boolean DEFAULT true NOT NULL,
	"state" text DEFAULT 'watching' NOT NULL,
	"reason" text,
	"state_since" timestamp DEFAULT now() NOT NULL,
	"last_reading" jsonb,
	"last_reading_at" timestamp,
	"hot_streak" integer DEFAULT 0 NOT NULL,
	"last_hot_at" timestamp,
	"readings" integer DEFAULT 0 NOT NULL,
	"hot_readings" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recorder_autopilot_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"channel_id" text,
	"action" text NOT NULL,
	"reason" text NOT NULL,
	"applied" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recorder_autopilot_outcomes" (
	"video_id" integer PRIMARY KEY NOT NULL,
	"channel" text NOT NULL,
	"file_name" text NOT NULL,
	"status" text NOT NULL,
	"clips" integer NOT NULL,
	"kept" integer NOT NULL,
	"skipped" integer NOT NULL,
	"recorded_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
