CREATE TABLE "video_watch_heat" (
	"video_id" integer PRIMARY KEY NOT NULL,
	"bucket_seconds" smallint DEFAULT 5 NOT NULL,
	"buckets" real[] NOT NULL,
	"watched_seconds" real DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "video_watch_heat" ADD CONSTRAINT "video_watch_heat_video_id_videos_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."videos"("id") ON DELETE cascade ON UPDATE no action;