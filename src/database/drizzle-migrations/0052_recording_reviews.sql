CREATE TABLE "recording_reviews" (
	"video_id" integer PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"clips" jsonb NOT NULL,
	"curve" jsonb NOT NULL,
	"prompts_revision" text NOT NULL,
	"delete_original" boolean DEFAULT false NOT NULL,
	"error" text,
	"analyzed_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "recording_reviews" ADD CONSTRAINT "recording_reviews_video_id_videos_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."videos"("id") ON DELETE cascade ON UPDATE no action;