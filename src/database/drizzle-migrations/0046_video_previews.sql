CREATE TABLE "video_previews" (
	"id" serial PRIMARY KEY NOT NULL,
	"video_id" integer NOT NULL,
	"file_path" text NOT NULL,
	"file_size_bytes" bigint NOT NULL,
	"duration_seconds" real NOT NULL,
	"clip_count" integer NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"has_audio" boolean NOT NULL,
	"generated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "video_previews_video_id_unique" UNIQUE("video_id")
);
--> statement-breakpoint
ALTER TABLE "video_previews" ADD CONSTRAINT "video_previews_video_id_videos_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."videos"("id") ON DELETE cascade ON UPDATE no action;