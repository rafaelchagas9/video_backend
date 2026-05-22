CREATE TABLE "face_images" (
	"id" serial PRIMARY KEY NOT NULL,
	"detection_id" integer NOT NULL,
	"file_path" text NOT NULL,
	"file_size_bytes" integer,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"generated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "face_images" ADD CONSTRAINT "face_images_detection_id_video_face_detections_id_fk" FOREIGN KEY ("detection_id") REFERENCES "public"."video_face_detections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "face_images_detection_id_unique" ON "face_images" USING btree ("detection_id");--> statement-breakpoint
CREATE INDEX "idx_face_images_detection" ON "face_images" USING btree ("detection_id");
