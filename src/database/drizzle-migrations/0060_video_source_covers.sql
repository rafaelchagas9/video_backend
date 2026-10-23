CREATE TABLE "video_source_covers" (
	"video_id" integer PRIMARY KEY NOT NULL,
	"source_url" text NOT NULL,
	"file_path" text NOT NULL,
	"thumb_path" text,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"file_size_bytes" bigint NOT NULL,
	"content_hash" text NOT NULL,
	"fetched_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "video_source_covers" ADD CONSTRAINT "video_source_covers_video_id_videos_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."videos"("id") ON DELETE cascade ON UPDATE no action;