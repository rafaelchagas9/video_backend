DROP INDEX "idx_video_metadata_video";--> statement-breakpoint
DROP INDEX "idx_video_metadata_key";--> statement-breakpoint
DROP INDEX "idx_video_related_scores_computed_at";--> statement-breakpoint
DROP INDEX "idx_conversion_jobs_video";--> statement-breakpoint
DROP INDEX "idx_conversion_jobs_status";--> statement-breakpoint
CREATE INDEX "idx_video_metadata_video_key" ON "video_metadata" USING btree ("video_id","key");--> statement-breakpoint
CREATE INDEX "idx_video_related_scores_source_computed" ON "video_related_scores" USING btree ("source_video_id","computed_at");--> statement-breakpoint
CREATE INDEX "idx_playlists_user" ON "playlists" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_conversion_jobs_video_preset_status" ON "conversion_jobs" USING btree ("video_id","preset","status");