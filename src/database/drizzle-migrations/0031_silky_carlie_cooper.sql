ALTER TABLE "edit_jobs" ADD COLUMN "active_video_id" integer;--> statement-breakpoint
UPDATE "edit_jobs"
SET "active_video_id" = "video_id"
WHERE "status" IN ('pending', 'queued', 'running');--> statement-breakpoint
ALTER TABLE "edit_jobs" ADD CONSTRAINT "edit_jobs_active_video_id_videos_id_fk" FOREIGN KEY ("active_video_id") REFERENCES "public"."videos"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_edit_jobs_active_video" ON "edit_jobs" USING btree ("active_video_id");--> statement-breakpoint
ALTER TABLE "edit_jobs" ADD CONSTRAINT "edit_jobs_active_video_status_check" CHECK ((("edit_jobs"."status" in ('pending', 'queued', 'running')) and "edit_jobs"."active_video_id" is not null) or (("edit_jobs"."status" in ('completed', 'failed', 'cancelled')) and "edit_jobs"."active_video_id" is null));--> statement-breakpoint
ALTER TABLE "edit_jobs" DROP CONSTRAINT "edit_jobs_video_id_videos_id_fk";
