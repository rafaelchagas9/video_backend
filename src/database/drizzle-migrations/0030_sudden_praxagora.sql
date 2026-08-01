CREATE TABLE "artwork_assets" (
	"id" serial PRIMARY KEY NOT NULL,
	"video_id" integer NOT NULL,
	"variant" text NOT NULL,
	"content_hash" text NOT NULL,
	"file_path" text NOT NULL,
	"file_size_bytes" integer NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"source_timestamp_seconds" real,
	"crop" jsonb,
	"focal_point" jsonb,
	"safe_area" jsonb,
	"bottom_luma" real,
	"thumbhash" text,
	"effects" jsonb NOT NULL,
	"generated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "artwork_assets_video_variant_unique" UNIQUE("video_id","variant"),
	CONSTRAINT "artwork_assets_variant_check" CHECK ("artwork_assets"."variant" IN ('card', 'poster', 'square', 'hero', 'title'))
);
--> statement-breakpoint
CREATE TABLE "video_artwork" (
	"id" serial PRIMARY KEY NOT NULL,
	"video_id" integer NOT NULL,
	"status" text DEFAULT 'absent' NOT NULL,
	"palette" jsonb,
	"error" text,
	"request" jsonb,
	"generated_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "video_artwork_video_id_unique" UNIQUE("video_id"),
	CONSTRAINT "video_artwork_status_check" CHECK ("video_artwork"."status" IN ('ready', 'generating', 'failed', 'absent'))
);
--> statement-breakpoint
ALTER TABLE "artwork_assets" ADD CONSTRAINT "artwork_assets_video_id_videos_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."videos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_artwork" ADD CONSTRAINT "video_artwork_video_id_videos_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."videos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_artwork_assets_video" ON "artwork_assets" USING btree ("video_id");--> statement-breakpoint
CREATE INDEX "idx_artwork_assets_content_hash" ON "artwork_assets" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "idx_video_artwork_status" ON "video_artwork" USING btree ("status");