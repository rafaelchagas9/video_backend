-- Drop old enrichment index/constraint names that the new polymorphic tables reuse,
-- so both can coexist for the data backfill below before the old tables are dropped.
DROP INDEX IF EXISTS "idx_enrichment_suggestions_type";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_enrichment_runs_finished_at";--> statement-breakpoint
ALTER TABLE "creator_enrichment_suggestions" DROP CONSTRAINT IF EXISTS "unique_enrichment_suggestion_dedup";--> statement-breakpoint
CREATE TABLE "video_external_ids" (
	"id" serial PRIMARY KEY NOT NULL,
	"video_id" integer NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"external_url" text,
	"last_synced_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "unique_video_external_id" UNIQUE("source","external_id")
);
--> statement-breakpoint
CREATE TABLE "tag_aliases" (
	"id" serial PRIMARY KEY NOT NULL,
	"tag_id" integer NOT NULL,
	"name" text NOT NULL,
	"note" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "unique_tag_alias" UNIQUE("tag_id","name")
);
--> statement-breakpoint
CREATE TABLE "tag_categories" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"group" text,
	"description" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "tag_categories_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "tag_external_ids" (
	"id" serial PRIMARY KEY NOT NULL,
	"tag_id" integer NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"external_url" text,
	"last_synced_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "unique_tag_external_id" UNIQUE("source","external_id")
);
--> statement-breakpoint
CREATE TABLE "enrichment_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" integer NOT NULL,
	"status" text NOT NULL,
	"sources_used" jsonb,
	"suggestion_count" integer DEFAULT 0 NOT NULL,
	"errors" jsonb,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "enrichment_suggestions" (
	"id" serial PRIMARY KEY NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" integer NOT NULL,
	"type" text NOT NULL,
	"field_key" text,
	"value" text NOT NULL,
	"source" text NOT NULL,
	"source_url" text,
	"confidence" real,
	"face_match_score" real,
	"cached_preview_path" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"dedup_hash" text NOT NULL,
	"raw" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "unique_enrichment_suggestion_dedup" UNIQUE("entity_type","entity_id","dedup_hash")
);
--> statement-breakpoint
INSERT INTO "enrichment_suggestions" ("entity_type","entity_id","type","field_key","value","source","source_url","confidence","face_match_score","cached_preview_path","status","dedup_hash","raw","created_at","updated_at")
SELECT 'creator',"creator_id","type","field_key","value","source","source_url","confidence","face_match_score","cached_preview_path","status","dedup_hash","raw","created_at","updated_at"
FROM "creator_enrichment_suggestions";--> statement-breakpoint
INSERT INTO "enrichment_runs" ("entity_type","entity_id","status","sources_used","suggestion_count","errors","started_at","finished_at")
SELECT 'creator',"creator_id","status","sources_used","suggestion_count","errors","started_at","finished_at"
FROM "creator_enrichment_runs";--> statement-breakpoint
ALTER TABLE "creator_enrichment_runs" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "creator_enrichment_suggestions" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "creator_enrichment_runs" CASCADE;--> statement-breakpoint
DROP TABLE "creator_enrichment_suggestions" CASCADE;--> statement-breakpoint
ALTER TABLE "tags" ADD COLUMN "category_id" integer;--> statement-breakpoint
ALTER TABLE "video_external_ids" ADD CONSTRAINT "video_external_ids_video_id_videos_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."videos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_aliases" ADD CONSTRAINT "tag_aliases_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_external_ids" ADD CONSTRAINT "tag_external_ids_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_video_external_ids_video" ON "video_external_ids" USING btree ("video_id");--> statement-breakpoint
CREATE INDEX "idx_tag_aliases_tag" ON "tag_aliases" USING btree ("tag_id");--> statement-breakpoint
CREATE INDEX "idx_tag_aliases_name" ON "tag_aliases" USING btree ("name");--> statement-breakpoint
CREATE INDEX "idx_tag_external_ids_tag" ON "tag_external_ids" USING btree ("tag_id");--> statement-breakpoint
CREATE INDEX "idx_enrichment_runs_entity" ON "enrichment_runs" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "idx_enrichment_runs_finished_at" ON "enrichment_runs" USING btree ("finished_at");--> statement-breakpoint
CREATE INDEX "idx_enrichment_suggestions_entity_status" ON "enrichment_suggestions" USING btree ("entity_type","entity_id","status");--> statement-breakpoint
CREATE INDEX "idx_enrichment_suggestions_type" ON "enrichment_suggestions" USING btree ("type");--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_category_id_tag_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."tag_categories"("id") ON DELETE set null ON UPDATE no action;