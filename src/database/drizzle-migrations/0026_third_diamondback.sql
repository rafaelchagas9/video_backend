CREATE TABLE "creator_enrichment_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"creator_id" integer NOT NULL,
	"status" text NOT NULL,
	"sources_used" jsonb,
	"suggestion_count" integer DEFAULT 0 NOT NULL,
	"errors" jsonb,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "creator_enrichment_suggestions" (
	"id" serial PRIMARY KEY NOT NULL,
	"creator_id" integer NOT NULL,
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
	CONSTRAINT "unique_enrichment_suggestion_dedup" UNIQUE("creator_id","dedup_hash")
);
--> statement-breakpoint
ALTER TABLE "creator_enrichment_runs" ADD CONSTRAINT "creator_enrichment_runs_creator_id_creators_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."creators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_enrichment_suggestions" ADD CONSTRAINT "creator_enrichment_suggestions_creator_id_creators_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."creators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_enrichment_runs_creator" ON "creator_enrichment_runs" USING btree ("creator_id");--> statement-breakpoint
CREATE INDEX "idx_enrichment_runs_finished_at" ON "creator_enrichment_runs" USING btree ("finished_at");--> statement-breakpoint
CREATE INDEX "idx_enrichment_suggestions_creator_status" ON "creator_enrichment_suggestions" USING btree ("creator_id","status");--> statement-breakpoint
CREATE INDEX "idx_enrichment_suggestions_type" ON "creator_enrichment_suggestions" USING btree ("type");