CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "tag_visual_queries" (
	"id" serial PRIMARY KEY NOT NULL,
	"tag_id" integer NOT NULL,
	"query" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "tag_visual_queries_tag_query_unique" UNIQUE("tag_id","query")
);
--> statement-breakpoint
CREATE TABLE "video_frame_embeddings" (
	"video_id" integer NOT NULL,
	"frame_index" integer NOT NULL,
	"timestamp_seconds" real NOT NULL,
	"embedding" halfvec(1152) NOT NULL,
	CONSTRAINT "video_frame_embeddings_video_id_frame_index_pk" PRIMARY KEY("video_id","frame_index")
);
--> statement-breakpoint
CREATE TABLE "video_visual_index" (
	"video_id" integer PRIMARY KEY NOT NULL,
	"model_revision" text NOT NULL,
	"storyboard_generated_at" timestamp NOT NULL,
	"interval_seconds" real NOT NULL,
	"frame_count" integer NOT NULL,
	"indexed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tag_visual_queries" ADD CONSTRAINT "tag_visual_queries_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_frame_embeddings" ADD CONSTRAINT "video_frame_embeddings_video_id_videos_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."videos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_visual_index" ADD CONSTRAINT "video_visual_index_video_id_videos_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."videos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_tag_visual_queries_tag" ON "tag_visual_queries" USING btree ("tag_id");--> statement-breakpoint
-- Cosine HNSW over fp16 vectors. The backfill script drops and rebuilds this around bulk loads.
CREATE INDEX IF NOT EXISTS "idx_video_frame_embeddings_hnsw" ON "video_frame_embeddings" USING hnsw ("embedding" halfvec_cosine_ops) WITH (m = 16, ef_construction = 64);
--> statement-breakpoint
-- Legacy installs never received the storyboards → videos foreign key the ORM declares, so
-- deleting a video left its storyboard row (and the files the row named) behind.
DELETE FROM "storyboards" s WHERE NOT EXISTS (SELECT 1 FROM "videos" v WHERE v.id = s.video_id);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'storyboards'::regclass AND contype = 'f' AND confrelid = 'videos'::regclass
  ) THEN
    ALTER TABLE "storyboards" ADD CONSTRAINT "storyboards_video_id_videos_id_fk"
      FOREIGN KEY ("video_id") REFERENCES "public"."videos"("id") ON DELETE cascade;
  END IF;
END $$;
