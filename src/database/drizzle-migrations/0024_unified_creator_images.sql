ALTER TABLE "creator_gallery_media" ADD COLUMN "is_profile_picture" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "creator_gallery_media" ADD COLUMN "is_main_picture" boolean DEFAULT false NOT NULL;--> statement-breakpoint
INSERT INTO "creator_gallery_media" (
	"creator_id",
	"label",
	"description",
	"file_path",
	"is_profile_picture",
	"is_main_picture",
	"created_at",
	"updated_at"
)
SELECT
	"id",
	'Profile picture',
	'Migrated from creators.profile_picture_path',
	"profile_picture_path",
	true,
	false,
	"created_at",
	"updated_at"
FROM "creators"
WHERE "profile_picture_path" IS NOT NULL
  AND NOT EXISTS (
	SELECT 1 FROM "creator_gallery_media"
	WHERE "creator_gallery_media"."creator_id" = "creators"."id"
	  AND "creator_gallery_media"."file_path" = "creators"."profile_picture_path"
  );--> statement-breakpoint
UPDATE "creator_gallery_media"
SET "is_profile_picture" = true,
	"updated_at" = now()
FROM "creators"
WHERE "creator_gallery_media"."creator_id" = "creators"."id"
  AND "creator_gallery_media"."file_path" = "creators"."profile_picture_path";--> statement-breakpoint
INSERT INTO "creator_gallery_media" (
	"creator_id",
	"label",
	"description",
	"file_path",
	"is_profile_picture",
	"is_main_picture",
	"created_at",
	"updated_at"
)
SELECT
	"id",
	'Main picture',
	'Migrated from creators.main_picture_path',
	"main_picture_path",
	false,
	true,
	"created_at",
	"updated_at"
FROM "creators"
WHERE "main_picture_path" IS NOT NULL
  AND "main_picture_path" IS DISTINCT FROM "profile_picture_path"
  AND NOT EXISTS (
	SELECT 1 FROM "creator_gallery_media"
	WHERE "creator_gallery_media"."creator_id" = "creators"."id"
	  AND "creator_gallery_media"."file_path" = "creators"."main_picture_path"
  );--> statement-breakpoint
UPDATE "creator_gallery_media"
SET "is_main_picture" = true,
	"updated_at" = now()
FROM "creators"
WHERE "creator_gallery_media"."creator_id" = "creators"."id"
  AND "creator_gallery_media"."file_path" = "creators"."main_picture_path";--> statement-breakpoint
CREATE INDEX "idx_creator_gallery_media_profile" ON "creator_gallery_media" USING btree ("creator_id", "is_profile_picture");--> statement-breakpoint
CREATE INDEX "idx_creator_gallery_media_main" ON "creator_gallery_media" USING btree ("creator_id", "is_main_picture");
