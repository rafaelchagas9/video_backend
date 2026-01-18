CREATE TABLE "creator_face_embeddings" (
	"id" serial PRIMARY KEY NOT NULL,
	"creator_id" integer NOT NULL,
	"embedding" text NOT NULL,
	"source_type" text NOT NULL,
	"source_video_id" integer,
	"source_timestamp_seconds" real,
	"det_score" real,
	"is_primary" boolean DEFAULT false NOT NULL,
	"estimated_age" integer,
	"estimated_gender" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "face_extraction_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"video_id" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"total_frames" integer,
	"processed_frames" integer DEFAULT 0 NOT NULL,
	"faces_detected" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "face_extraction_jobs_video_id_unique" UNIQUE("video_id")
);
--> statement-breakpoint
CREATE TABLE "video_face_detections" (
	"id" serial PRIMARY KEY NOT NULL,
	"video_id" integer NOT NULL,
	"embedding" text NOT NULL,
	"timestamp_seconds" real NOT NULL,
	"frame_index" integer,
	"bbox_x1" real NOT NULL,
	"bbox_y1" real NOT NULL,
	"bbox_x2" real NOT NULL,
	"bbox_y2" real NOT NULL,
	"det_score" real NOT NULL,
	"matched_creator_id" integer,
	"match_confidence" real,
	"match_status" text DEFAULT 'pending' NOT NULL,
	"estimated_age" integer,
	"estimated_gender" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "creator_face_embeddings" ADD CONSTRAINT "creator_face_embeddings_creator_id_creators_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."creators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_face_embeddings" ADD CONSTRAINT "creator_face_embeddings_source_video_id_videos_id_fk" FOREIGN KEY ("source_video_id") REFERENCES "public"."videos"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "face_extraction_jobs" ADD CONSTRAINT "face_extraction_jobs_video_id_videos_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."videos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_face_detections" ADD CONSTRAINT "video_face_detections_video_id_videos_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."videos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_face_detections" ADD CONSTRAINT "video_face_detections_matched_creator_id_creators_id_fk" FOREIGN KEY ("matched_creator_id") REFERENCES "public"."creators"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_creator_face_embeddings_creator" ON "creator_face_embeddings" USING btree ("creator_id");--> statement-breakpoint
CREATE INDEX "idx_creator_face_embeddings_source_video" ON "creator_face_embeddings" USING btree ("source_video_id");--> statement-breakpoint
CREATE INDEX "idx_creator_face_embeddings_is_primary" ON "creator_face_embeddings" USING btree ("is_primary");--> statement-breakpoint
CREATE INDEX "idx_face_extraction_jobs_video" ON "face_extraction_jobs" USING btree ("video_id");--> statement-breakpoint
CREATE INDEX "idx_face_extraction_jobs_status" ON "face_extraction_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_face_extraction_jobs_created_at" ON "face_extraction_jobs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_video_face_detections_video" ON "video_face_detections" USING btree ("video_id");--> statement-breakpoint
CREATE INDEX "idx_video_face_detections_timestamp" ON "video_face_detections" USING btree ("video_id","timestamp_seconds");--> statement-breakpoint
CREATE INDEX "idx_video_face_detections_matched_creator" ON "video_face_detections" USING btree ("matched_creator_id");--> statement-breakpoint
CREATE INDEX "idx_video_face_detections_match_status" ON "video_face_detections" USING btree ("match_status");