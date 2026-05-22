CREATE TABLE "conversion_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"conversion_job_id" integer,
	"video_id" integer,
	"source_file_path" text NOT NULL,
	"source_file_name" text NOT NULL,
	"output_file_path" text NOT NULL,
	"preset" text NOT NULL,
	"codec" text NOT NULL,
	"target_resolution" text,
	"ffmpeg_command" text NOT NULL,
	"original_size_bytes" integer NOT NULL,
	"output_size_bytes" integer NOT NULL,
	"size_delta_bytes" integer NOT NULL,
	"size_change_percent" real NOT NULL,
	"conversion_duration_ms" integer,
	"started_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversion_history" ADD CONSTRAINT "conversion_history_conversion_job_id_conversion_jobs_id_fk" FOREIGN KEY ("conversion_job_id") REFERENCES "public"."conversion_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversion_history" ADD CONSTRAINT "conversion_history_video_id_videos_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."videos"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_conversion_history_created_at" ON "conversion_history" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_conversion_history_preset" ON "conversion_history" USING btree ("preset");--> statement-breakpoint
CREATE INDEX "idx_conversion_history_video" ON "conversion_history" USING btree ("video_id");--> statement-breakpoint
CREATE INDEX "idx_conversion_history_job" ON "conversion_history" USING btree ("conversion_job_id");