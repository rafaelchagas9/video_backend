CREATE TABLE "cleanup_reviews" (
	"user_id" integer NOT NULL,
	"video_id" integer NOT NULL,
	"disposition" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"first_reviewed_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "cleanup_reviews_user_id_video_id_pk" PRIMARY KEY("user_id","video_id"),
	CONSTRAINT "cleanup_reviews_disposition_check" CHECK ("cleanup_reviews"."disposition" IN ('keep', 'delete', 'later'))
);
--> statement-breakpoint
ALTER TABLE "cleanup_reviews" ADD CONSTRAINT "cleanup_reviews_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cleanup_reviews" ADD CONSTRAINT "cleanup_reviews_video_id_videos_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."videos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_cleanup_reviews_user_disposition" ON "cleanup_reviews" USING btree ("user_id","disposition","updated_at");