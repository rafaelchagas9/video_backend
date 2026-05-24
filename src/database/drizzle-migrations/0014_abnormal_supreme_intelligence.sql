CREATE TABLE "video_collection_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"collection_id" integer NOT NULL,
	"video_id" integer NOT NULL,
	"entry_kind" text NOT NULL,
	"sequence_number" integer,
	"season_number" integer,
	"episode_number" integer,
	"episode_part" integer,
	"absolute_number" integer,
	"display_title_override" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "video_collection_entries_collection_video_unique" UNIQUE("collection_id","video_id"),
	CONSTRAINT "video_collection_entries_kind_check" CHECK ("video_collection_entries"."entry_kind" IN ('movie', 'episode', 'special', 'extra')),
	CONSTRAINT "video_collection_entries_sequence_check" CHECK ("video_collection_entries"."sequence_number" IS NULL OR "video_collection_entries"."sequence_number" >= 1),
	CONSTRAINT "video_collection_entries_season_check" CHECK ("video_collection_entries"."season_number" IS NULL OR "video_collection_entries"."season_number" >= 0),
	CONSTRAINT "video_collection_entries_episode_check" CHECK ("video_collection_entries"."episode_number" IS NULL OR "video_collection_entries"."episode_number" >= 1),
	CONSTRAINT "video_collection_entries_episode_part_check" CHECK ("video_collection_entries"."episode_part" IS NULL OR "video_collection_entries"."episode_part" >= 1),
	CONSTRAINT "video_collection_entries_absolute_check" CHECK ("video_collection_entries"."absolute_number" IS NULL OR "video_collection_entries"."absolute_number" >= 1),
	CONSTRAINT "video_collection_entries_episodic_coordinate_check" CHECK (("video_collection_entries"."episode_number" IS NULL AND "video_collection_entries"."season_number" IS NULL) OR ("video_collection_entries"."episode_number" IS NOT NULL AND "video_collection_entries"."season_number" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "video_collections" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"kind" text NOT NULL,
	"description" text,
	"release_year" integer,
	"external_ids_json" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "video_collections_kind_check" CHECK ("video_collections"."kind" IN ('movie_series', 'tv_series', 'mini_series', 'anthology', 'other')),
	CONSTRAINT "video_collections_release_year_check" CHECK ("video_collections"."release_year" IS NULL OR "video_collections"."release_year" >= 1800)
);
--> statement-breakpoint
ALTER TABLE "video_collection_entries" ADD CONSTRAINT "video_collection_entries_collection_id_video_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."video_collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_collection_entries" ADD CONSTRAINT "video_collection_entries_video_id_videos_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."videos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "video_collection_entries_video_unique" ON "video_collection_entries" USING btree ("video_id");--> statement-breakpoint
CREATE INDEX "idx_video_collection_entries_collection" ON "video_collection_entries" USING btree ("collection_id");--> statement-breakpoint
CREATE INDEX "idx_video_collection_entries_collection_order" ON "video_collection_entries" USING btree ("collection_id","sequence_number","season_number","episode_number","episode_part","absolute_number");--> statement-breakpoint
CREATE UNIQUE INDEX "video_collection_entries_sequence_unique" ON "video_collection_entries" USING btree ("collection_id","sequence_number") WHERE "video_collection_entries"."sequence_number" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "video_collection_entries_episode_unique" ON "video_collection_entries" USING btree ("collection_id","season_number","episode_number",COALESCE("episode_part", 0)) WHERE "video_collection_entries"."season_number" IS NOT NULL AND "video_collection_entries"."episode_number" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_video_collections_title" ON "video_collections" USING btree ("title");--> statement-breakpoint
CREATE INDEX "idx_video_collections_kind" ON "video_collections" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "idx_video_collections_release_year" ON "video_collections" USING btree ("release_year");