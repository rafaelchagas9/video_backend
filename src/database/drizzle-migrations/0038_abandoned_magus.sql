CREATE TABLE "bookmark_categories" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'custom' NOT NULL,
	"user_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "bookmark_categories_ownership_check" CHECK (("bookmark_categories"."kind" = 'system' AND "bookmark_categories"."user_id" IS NULL) OR ("bookmark_categories"."kind" = 'custom' AND "bookmark_categories"."user_id" IS NOT NULL)),
	CONSTRAINT "bookmark_categories_reserved_system_key_check" CHECK ("bookmark_categories"."kind" = 'system' OR "bookmark_categories"."key" NOT IN ('BUTTOCKS_EXPOSED', 'FEMALE_BREAST_EXPOSED', 'FEMALE_GENITALIA_EXPOSED', 'MALE_BREAST_EXPOSED', 'ANUS_EXPOSED', 'FEET_EXPOSED', 'ARMPITS_EXPOSED', 'BELLY_EXPOSED', 'MALE_GENITALIA_EXPOSED', 'ANUS_COVERED', 'FEMALE_GENITALIA_COVERED'))
);
--> statement-breakpoint
CREATE TABLE "bookmark_category_assignments" (
	"bookmark_id" integer NOT NULL,
	"category_id" integer NOT NULL,
	"confidence" real,
	"provider_label" text,
	CONSTRAINT "bookmark_category_assignments_bookmark_id_category_id_pk" PRIMARY KEY("bookmark_id","category_id"),
	CONSTRAINT "bookmark_category_assignments_confidence_check" CHECK ("bookmark_category_assignments"."confidence" IS NULL OR ("bookmark_category_assignments"."confidence" >= 0 AND "bookmark_category_assignments"."confidence" <= 1))
);
--> statement-breakpoint
ALTER TABLE "bookmarks" ADD COLUMN "end_timestamp_seconds" real;--> statement-breakpoint
ALTER TABLE "bookmarks" ADD COLUMN "peak_timestamp_seconds" real;--> statement-breakpoint
ALTER TABLE "bookmarks" ADD COLUMN "origin" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "bookmarks" ADD COLUMN "analysis_run_id" integer;--> statement-breakpoint
ALTER TABLE "bookmarks" ADD COLUMN "user_modified_at" timestamp;--> statement-breakpoint
ALTER TABLE "bookmark_categories" ADD CONSTRAINT "bookmark_categories_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookmark_category_assignments" ADD CONSTRAINT "bookmark_category_assignments_bookmark_id_bookmarks_id_fk" FOREIGN KEY ("bookmark_id") REFERENCES "public"."bookmarks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookmark_category_assignments" ADD CONSTRAINT "bookmark_category_assignments_category_id_bookmark_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."bookmark_categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bookmark_categories_system_key_unique" ON "bookmark_categories" USING btree ("key") WHERE "bookmark_categories"."kind" = 'system';--> statement-breakpoint
CREATE UNIQUE INDEX "bookmark_categories_custom_user_key_unique" ON "bookmark_categories" USING btree ("user_id","key") WHERE "bookmark_categories"."kind" = 'custom';--> statement-breakpoint
CREATE INDEX "idx_bookmark_categories_user" ON "bookmark_categories" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_bookmark_category_assignments_category" ON "bookmark_category_assignments" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "idx_bookmarks_origin" ON "bookmarks" USING btree ("origin");--> statement-breakpoint
CREATE INDEX "idx_bookmarks_analysis_run" ON "bookmarks" USING btree ("analysis_run_id");--> statement-breakpoint
ALTER TABLE "bookmarks" ADD CONSTRAINT "bookmarks_origin_check" CHECK ("bookmarks"."origin" IN ('manual', 'automatic'));--> statement-breakpoint
ALTER TABLE "bookmarks" ADD CONSTRAINT "bookmarks_timestamp_check" CHECK ("bookmarks"."timestamp_seconds" >= 0);--> statement-breakpoint
ALTER TABLE "bookmarks" ADD CONSTRAINT "bookmarks_interval_check" CHECK (("bookmarks"."end_timestamp_seconds" IS NULL AND "bookmarks"."peak_timestamp_seconds" IS NULL) OR ("bookmarks"."end_timestamp_seconds" IS NOT NULL AND "bookmarks"."peak_timestamp_seconds" IS NOT NULL AND "bookmarks"."timestamp_seconds" <= "bookmarks"."peak_timestamp_seconds" AND "bookmarks"."peak_timestamp_seconds" <= "bookmarks"."end_timestamp_seconds"));--> statement-breakpoint
ALTER TABLE "bookmarks" ADD CONSTRAINT "bookmarks_provenance_check" CHECK (("bookmarks"."origin" = 'manual' AND "bookmarks"."analysis_run_id" IS NULL) OR ("bookmarks"."origin" = 'automatic' AND "bookmarks"."analysis_run_id" IS NOT NULL));--> statement-breakpoint
INSERT INTO "bookmark_categories" ("key", "name", "kind", "user_id") VALUES
	('BUTTOCKS_EXPOSED', 'BUTTOCKS_EXPOSED', 'system', NULL),
	('FEMALE_BREAST_EXPOSED', 'FEMALE_BREAST_EXPOSED', 'system', NULL),
	('FEMALE_GENITALIA_EXPOSED', 'FEMALE_GENITALIA_EXPOSED', 'system', NULL),
	('MALE_BREAST_EXPOSED', 'MALE_BREAST_EXPOSED', 'system', NULL),
	('ANUS_EXPOSED', 'ANUS_EXPOSED', 'system', NULL),
	('FEET_EXPOSED', 'FEET_EXPOSED', 'system', NULL),
	('ARMPITS_EXPOSED', 'ARMPITS_EXPOSED', 'system', NULL),
	('BELLY_EXPOSED', 'BELLY_EXPOSED', 'system', NULL),
	('MALE_GENITALIA_EXPOSED', 'MALE_GENITALIA_EXPOSED', 'system', NULL),
	('ANUS_COVERED', 'ANUS_COVERED', 'system', NULL),
	('FEMALE_GENITALIA_COVERED', 'FEMALE_GENITALIA_COVERED', 'system', NULL)
ON CONFLICT ("key") WHERE "kind" = 'system'
DO UPDATE SET "name" = EXCLUDED."name", "updated_at" = now();
