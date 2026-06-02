CREATE TABLE "creator_body_modifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"creator_id" integer NOT NULL,
	"type" text NOT NULL,
	"location" text,
	"description" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "creator_external_ids" (
	"id" serial PRIMARY KEY NOT NULL,
	"creator_id" integer NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"external_url" text,
	"last_synced_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "unique_creator_external_id" UNIQUE("source","external_id")
);
--> statement-breakpoint
CREATE TABLE "creator_merges" (
	"id" serial PRIMARY KEY NOT NULL,
	"from_creator_id" integer NOT NULL,
	"into_creator_id" integer NOT NULL,
	"from_name" text,
	"snapshot" jsonb,
	"reason" text,
	"merged_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "studio_aliases" (
	"id" serial PRIMARY KEY NOT NULL,
	"studio_id" integer NOT NULL,
	"name" text NOT NULL,
	"note" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "unique_studio_alias" UNIQUE("studio_id","name")
);
--> statement-breakpoint
CREATE TABLE "studio_external_ids" (
	"id" serial PRIMARY KEY NOT NULL,
	"studio_id" integer NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"external_url" text,
	"last_synced_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "unique_studio_external_id" UNIQUE("source","external_id")
);
--> statement-breakpoint
ALTER TABLE "creators" ADD COLUMN "gender" text;--> statement-breakpoint
ALTER TABLE "creators" ADD COLUMN "birth_date" text;--> statement-breakpoint
ALTER TABLE "creators" ADD COLUMN "death_date" text;--> statement-breakpoint
ALTER TABLE "creators" ADD COLUMN "ethnicity" text;--> statement-breakpoint
ALTER TABLE "creators" ADD COLUMN "country" text;--> statement-breakpoint
ALTER TABLE "creators" ADD COLUMN "birthplace" text;--> statement-breakpoint
ALTER TABLE "creators" ADD COLUMN "eye_color" text;--> statement-breakpoint
ALTER TABLE "creators" ADD COLUMN "hair_color" text;--> statement-breakpoint
ALTER TABLE "creators" ADD COLUMN "height_cm" integer;--> statement-breakpoint
ALTER TABLE "creators" ADD COLUMN "cup_size" text;--> statement-breakpoint
ALTER TABLE "creators" ADD COLUMN "band_size" integer;--> statement-breakpoint
ALTER TABLE "creators" ADD COLUMN "waist_size" integer;--> statement-breakpoint
ALTER TABLE "creators" ADD COLUMN "hip_size" integer;--> statement-breakpoint
ALTER TABLE "creators" ADD COLUMN "breast_type" text;--> statement-breakpoint
ALTER TABLE "creators" ADD COLUMN "career_start_year" integer;--> statement-breakpoint
ALTER TABLE "creators" ADD COLUMN "career_end_year" integer;--> statement-breakpoint
ALTER TABLE "studios" ADD COLUMN "parent_studio_id" integer;--> statement-breakpoint
ALTER TABLE "creator_body_modifications" ADD CONSTRAINT "creator_body_modifications_creator_id_creators_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."creators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_external_ids" ADD CONSTRAINT "creator_external_ids_creator_id_creators_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."creators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_aliases" ADD CONSTRAINT "studio_aliases_studio_id_studios_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_external_ids" ADD CONSTRAINT "studio_external_ids_studio_id_studios_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_creator_body_modifications_creator" ON "creator_body_modifications" USING btree ("creator_id");--> statement-breakpoint
CREATE INDEX "idx_creator_external_ids_creator" ON "creator_external_ids" USING btree ("creator_id");--> statement-breakpoint
CREATE INDEX "idx_creator_merges_into" ON "creator_merges" USING btree ("into_creator_id");--> statement-breakpoint
CREATE INDEX "idx_studio_aliases_studio" ON "studio_aliases" USING btree ("studio_id");--> statement-breakpoint
CREATE INDEX "idx_studio_aliases_name" ON "studio_aliases" USING btree ("name");--> statement-breakpoint
CREATE INDEX "idx_studio_external_ids_studio" ON "studio_external_ids" USING btree ("studio_id");--> statement-breakpoint
ALTER TABLE "studios" ADD CONSTRAINT "studios_parent_studio_id_studios_id_fk" FOREIGN KEY ("parent_studio_id") REFERENCES "public"."studios"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_metadata" ADD CONSTRAINT "video_metadata_video_id_key_unique" UNIQUE("video_id","key");