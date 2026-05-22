CREATE TABLE "video_related_scores" (
	"source_video_id" integer NOT NULL,
	"related_video_id" integer NOT NULL,
	"score" real NOT NULL,
	"reasons_json" text NOT NULL,
	"computed_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "video_related_scores_source_video_id_related_video_id_pk" PRIMARY KEY("source_video_id","related_video_id")
);
--> statement-breakpoint
ALTER TABLE "video_related_scores" ADD CONSTRAINT "video_related_scores_source_video_id_videos_id_fk" FOREIGN KEY ("source_video_id") REFERENCES "public"."videos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_related_scores" ADD CONSTRAINT "video_related_scores_related_video_id_videos_id_fk" FOREIGN KEY ("related_video_id") REFERENCES "public"."videos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_video_related_scores_source_score" ON "video_related_scores" USING btree ("source_video_id","score");--> statement-breakpoint
CREATE INDEX "idx_video_related_scores_related" ON "video_related_scores" USING btree ("related_video_id");--> statement-breakpoint
CREATE INDEX "idx_video_related_scores_computed_at" ON "video_related_scores" USING btree ("computed_at");