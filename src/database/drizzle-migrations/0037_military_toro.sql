ALTER TABLE "face_extraction_jobs" DROP CONSTRAINT "face_extraction_jobs_video_id_unique";--> statement-breakpoint
ALTER TABLE "face_extraction_jobs" ADD COLUMN "durable_job_id" integer;--> statement-breakpoint
ALTER TABLE "face_extraction_jobs" ADD COLUMN "source_fingerprint" text;--> statement-breakpoint
ALTER TABLE "face_extraction_jobs" ADD COLUMN "config" jsonb;--> statement-breakpoint
ALTER TABLE "face_extraction_jobs" ADD COLUMN "is_published" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "video_face_detections" ADD COLUMN "face_extraction_job_id" integer;--> statement-breakpoint
ALTER TABLE "video_face_detections" ADD COLUMN "is_published" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "face_extraction_jobs" ADD CONSTRAINT "face_extraction_jobs_durable_job_id_durable_jobs_id_fk" FOREIGN KEY ("durable_job_id") REFERENCES "public"."durable_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_face_detections" ADD CONSTRAINT "video_face_detections_face_extraction_job_id_face_extraction_jobs_id_fk" FOREIGN KEY ("face_extraction_job_id") REFERENCES "public"."face_extraction_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_face_extraction_jobs_active_video" ON "face_extraction_jobs" USING btree ("video_id") WHERE "face_extraction_jobs"."status" IN ('pending', 'processing');--> statement-breakpoint
CREATE INDEX "idx_video_face_detections_extraction_job" ON "video_face_detections" USING btree ("face_extraction_job_id");--> statement-breakpoint
ALTER TABLE "face_extraction_jobs" ADD CONSTRAINT "face_extraction_jobs_durable_job_id_unique" UNIQUE("durable_job_id");