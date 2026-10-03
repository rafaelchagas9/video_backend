CREATE TABLE "identify_run_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL,
	"video_id" integer NOT NULL,
	"outcome" text NOT NULL,
	"source" text,
	"external_id" text,
	"detail" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identify_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"dry_run" boolean NOT NULL,
	"options" jsonb NOT NULL,
	"filter" jsonb NOT NULL,
	"counts" jsonb NOT NULL,
	"durable_job_id" integer,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"started_at" timestamp,
	"finished_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "stash_scene_links" (
	"video_id" integer PRIMARY KEY NOT NULL,
	"stash_scene_id" text NOT NULL,
	"stash_file_id" text NOT NULL,
	"file_path" text NOT NULL,
	"has_phash" boolean DEFAULT false NOT NULL,
	"synced_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "video_fingerprints" (
	"video_id" integer NOT NULL,
	"algorithm" text NOT NULL,
	"hash" text NOT NULL,
	"origin" text NOT NULL,
	"duration_seconds" real,
	"file_path" text,
	"recorded_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "video_fingerprints_video_id_algorithm_hash_pk" PRIMARY KEY("video_id","algorithm","hash")
);
--> statement-breakpoint
ALTER TABLE "identify_run_items" ADD CONSTRAINT "identify_run_items_run_id_identify_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."identify_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stash_scene_links" ADD CONSTRAINT "stash_scene_links_video_id_videos_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."videos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_fingerprints" ADD CONSTRAINT "video_fingerprints_video_id_videos_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."videos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_identify_run_items_run" ON "identify_run_items" USING btree ("run_id","outcome");--> statement-breakpoint
CREATE INDEX "idx_identify_run_items_video" ON "identify_run_items" USING btree ("video_id");--> statement-breakpoint
CREATE INDEX "idx_video_fingerprints_origin" ON "video_fingerprints" USING btree ("origin");