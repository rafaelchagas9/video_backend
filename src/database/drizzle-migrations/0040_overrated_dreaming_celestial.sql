CREATE TABLE "content_analysis_observation_chunks" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL,
	"phase" text NOT NULL,
	"chunk_index" integer NOT NULL,
	"start_seconds" real NOT NULL,
	"end_seconds" real NOT NULL,
	"sampled_frames" integer NOT NULL,
	"positive_frames" integer NOT NULL,
	"findings" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_analysis_observation_chunks_phase_check" CHECK ("content_analysis_observation_chunks"."phase" IN ('coarse', 'refining')),
	CONSTRAINT "content_analysis_observation_chunks_interval_check" CHECK ("content_analysis_observation_chunks"."chunk_index" >= 0 AND "content_analysis_observation_chunks"."start_seconds" >= 0 AND "content_analysis_observation_chunks"."end_seconds" >= "content_analysis_observation_chunks"."start_seconds"),
	CONSTRAINT "content_analysis_observation_chunks_counts_check" CHECK ("content_analysis_observation_chunks"."sampled_frames" >= 0 AND "content_analysis_observation_chunks"."positive_frames" >= 0 AND "content_analysis_observation_chunks"."positive_frames" <= "content_analysis_observation_chunks"."sampled_frames"),
	CONSTRAINT "content_analysis_observation_chunks_findings_check" CHECK (jsonb_typeof("content_analysis_observation_chunks"."findings") = 'array')
);
--> statement-breakpoint
ALTER TABLE "content_analysis_observation_chunks" ADD CONSTRAINT "content_analysis_observation_chunks_run_id_content_analysis_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."content_analysis_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "content_analysis_observation_chunks_run_phase_chunk_unique" ON "content_analysis_observation_chunks" USING btree ("run_id","phase","chunk_index");--> statement-breakpoint
CREATE INDEX "idx_content_analysis_observation_chunks_run_timeline" ON "content_analysis_observation_chunks" USING btree ("run_id","phase","start_seconds","chunk_index");