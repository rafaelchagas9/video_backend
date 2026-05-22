CREATE TABLE "edit_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"video_id" integer NOT NULL,
	"status" text NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"output_config" json NOT NULL,
	"timeline_config" json NOT NULL,
	"output_path" text,
	"output_video_id" integer,
	"error_message" text,
	"started_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "edit_jobs" ADD CONSTRAINT "edit_jobs_video_id_videos_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."videos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edit_jobs" ADD CONSTRAINT "edit_jobs_output_video_id_videos_id_fk" FOREIGN KEY ("output_video_id") REFERENCES "public"."videos"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_edit_jobs_video" ON "edit_jobs" USING btree ("video_id");--> statement-breakpoint
CREATE INDEX "idx_edit_jobs_status" ON "edit_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_edit_jobs_output_video" ON "edit_jobs" USING btree ("output_video_id");