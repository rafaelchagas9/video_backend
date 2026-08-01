ALTER TABLE "conversion_history" ADD COLUMN "duration_seconds" real;--> statement-breakpoint
ALTER TABLE "conversion_history" ADD COLUMN "source_width" integer;--> statement-breakpoint
ALTER TABLE "conversion_history" ADD COLUMN "source_height" integer;--> statement-breakpoint
ALTER TABLE "conversion_history" ADD COLUMN "source_fps" real;--> statement-breakpoint
ALTER TABLE "conversion_history" ADD COLUMN "source_codec" text;--> statement-breakpoint
ALTER TABLE "conversion_history" ADD COLUMN "source_audio_codec" text;--> statement-breakpoint
ALTER TABLE "conversion_history" ADD COLUMN "source_bitrate" integer;--> statement-breakpoint
ALTER TABLE "conversion_history" ADD COLUMN "output_width" integer;--> statement-breakpoint
ALTER TABLE "conversion_history" ADD COLUMN "output_height" integer;--> statement-breakpoint
ALTER TABLE "conversion_history" ADD COLUMN "output_fps" real;--> statement-breakpoint
ALTER TABLE "conversion_history" ADD COLUMN "output_codec" text;--> statement-breakpoint
ALTER TABLE "conversion_history" ADD COLUMN "output_audio_codec" text;--> statement-breakpoint
ALTER TABLE "conversion_history" ADD COLUMN "output_bitrate" integer;--> statement-breakpoint
CREATE INDEX "idx_conversion_history_size_change" ON "conversion_history" USING btree ("size_change_percent");--> statement-breakpoint
CREATE INDEX "idx_conversion_history_source_codec" ON "conversion_history" USING btree ("source_codec");