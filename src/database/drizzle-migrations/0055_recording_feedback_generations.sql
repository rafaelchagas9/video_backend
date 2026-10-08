ALTER TABLE "recording_clip_feedback" ADD COLUMN "merged_into" text;--> statement-breakpoint
ALTER TABLE "recording_clip_feedback" ADD COLUMN "shown_default" text;--> statement-breakpoint
ALTER TABLE "recording_clip_feedback" ADD COLUMN "label_type" text DEFAULT 'triage' NOT NULL;--> statement-breakpoint
ALTER TABLE "recording_clip_feedback" ADD COLUMN "save_batch" text;--> statement-breakpoint
ALTER TABLE "recording_clip_feedback" ADD COLUMN "queue_position" integer;--> statement-breakpoint
ALTER TABLE "recording_clip_feedback" ADD COLUMN "queue_sort" text;--> statement-breakpoint
ALTER TABLE "recording_clip_feedback" ADD COLUMN "audit" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "recording_clip_feedback" ADD COLUMN "channel_kept_seconds" double precision;--> statement-breakpoint
ALTER TABLE "recording_clip_feedback" ADD COLUMN "channel_rendered_seconds" double precision;--> statement-breakpoint
ALTER TABLE "recording_reviews" ADD COLUMN "proposals" jsonb;--> statement-breakpoint
ALTER TABLE "recording_reviews" ADD COLUMN "saved_at" timestamp;--> statement-breakpoint
-- Reviews with recorded decisions were saved at least by their last update.
UPDATE "recording_reviews" SET "saved_at" = "updated_at" WHERE "video_id" IN (SELECT DISTINCT "video_id" FROM "recording_clip_feedback");
