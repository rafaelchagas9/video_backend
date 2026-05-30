CREATE TABLE "creator_gallery_media" (
	"id" serial PRIMARY KEY NOT NULL,
	"creator_id" integer NOT NULL,
	"label" text,
	"description" text,
	"file_path" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "creators" ADD COLUMN "main_picture_path" text;--> statement-breakpoint
ALTER TABLE "creator_gallery_media" ADD CONSTRAINT "creator_gallery_media_creator_id_creators_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."creators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_creator_gallery_media_creator" ON "creator_gallery_media" USING btree ("creator_id");