CREATE TABLE "video_audio_fingerprints" (
	"video_id" integer PRIMARY KEY NOT NULL,
	"revision" text NOT NULL,
	"status" text NOT NULL,
	"source_size" bigint NOT NULL,
	"source_mtime_ns" text NOT NULL,
	"item_count" integer NOT NULL,
	"fingerprint" "bytea",
	"extracted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"matched_at" timestamp with time zone,
	CONSTRAINT "video_audio_fingerprints_status_check" CHECK ("video_audio_fingerprints"."status" IN ('ready', 'no_audio')),
	CONSTRAINT "video_audio_fingerprints_payload_check" CHECK (("video_audio_fingerprints"."status" = 'ready' AND "video_audio_fingerprints"."fingerprint" IS NOT NULL AND octet_length("video_audio_fingerprints"."fingerprint") = 4 * "video_audio_fingerprints"."item_count") OR ("video_audio_fingerprints"."status" = 'no_audio' AND "video_audio_fingerprints"."fingerprint" IS NULL AND "video_audio_fingerprints"."item_count" = 0))
);
--> statement-breakpoint
CREATE TABLE "video_copy_pairs" (
	"video_a" integer NOT NULL,
	"video_b" integer NOT NULL,
	"revision" text NOT NULL,
	"verdict" text NOT NULL,
	"status" text,
	"coverage_a" real DEFAULT 0 NOT NULL,
	"coverage_b" real DEFAULT 0 NOT NULL,
	"segments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evidence" jsonb NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "video_copy_pairs_video_a_video_b_pk" PRIMARY KEY("video_a","video_b"),
	CONSTRAINT "video_copy_pairs_order_check" CHECK ("video_copy_pairs"."video_a" < "video_copy_pairs"."video_b"),
	CONSTRAINT "video_copy_pairs_verdict_check" CHECK (("video_copy_pairs"."verdict" = 'match' AND "video_copy_pairs"."status" IN ('verified', 'ambiguous')) OR ("video_copy_pairs"."verdict" = 'rejected' AND "video_copy_pairs"."status" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "video_audio_fingerprints" ADD CONSTRAINT "video_audio_fingerprints_video_id_videos_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."videos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_copy_pairs" ADD CONSTRAINT "video_copy_pairs_video_a_videos_id_fk" FOREIGN KEY ("video_a") REFERENCES "public"."videos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_copy_pairs" ADD CONSTRAINT "video_copy_pairs_video_b_videos_id_fk" FOREIGN KEY ("video_b") REFERENCES "public"."videos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_video_audio_fingerprints_pending" ON "video_audio_fingerprints" USING btree ("video_id") WHERE "video_audio_fingerprints"."matched_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_video_copy_pairs_video_b" ON "video_copy_pairs" USING btree ("video_b");--> statement-breakpoint
CREATE INDEX "idx_video_copy_pairs_matches" ON "video_copy_pairs" USING btree ("checked_at") WHERE "video_copy_pairs"."verdict" = 'match';