ALTER TABLE "conversion_history" ADD COLUMN "profile_version" integer;--> statement-breakpoint
ALTER TABLE "conversion_history" ADD COLUMN "planned_video_bitrate" integer;--> statement-breakpoint
ALTER TABLE "conversion_history" ADD COLUMN "planned_max_bitrate" integer;--> statement-breakpoint
ALTER TABLE "conversion_history" ADD COLUMN "planned_qp" integer;--> statement-breakpoint
ALTER TABLE "conversion_history" ADD COLUMN "effective_resolution" text;--> statement-breakpoint
ALTER TABLE "conversion_history" ADD COLUMN "encoding_mode" text;