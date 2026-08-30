CREATE TABLE `demo_bookmark_categories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'custom' NOT NULL,
	`user_id` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "demo_bookmark_categories_ownership_check" CHECK(("demo_bookmark_categories"."kind" = 'system' AND "demo_bookmark_categories"."user_id" IS NULL) OR ("demo_bookmark_categories"."kind" = 'custom' AND "demo_bookmark_categories"."user_id" IS NOT NULL)),
	CONSTRAINT "demo_bookmark_categories_reserved_system_key_check" CHECK("demo_bookmark_categories"."kind" = 'system' OR "demo_bookmark_categories"."key" NOT IN ('BUTTOCKS_EXPOSED', 'FEMALE_BREAST_EXPOSED', 'FEMALE_GENITALIA_EXPOSED', 'MALE_BREAST_EXPOSED', 'ANUS_EXPOSED', 'FEET_EXPOSED', 'ARMPITS_EXPOSED', 'BELLY_EXPOSED', 'MALE_GENITALIA_EXPOSED', 'ANUS_COVERED', 'FEMALE_GENITALIA_COVERED'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `demo_bookmark_categories_system_key_unique` ON `demo_bookmark_categories` (`key`) WHERE "demo_bookmark_categories"."kind" = 'system';--> statement-breakpoint
CREATE UNIQUE INDEX `demo_bookmark_categories_custom_user_key_unique` ON `demo_bookmark_categories` (`user_id`,`key`) WHERE "demo_bookmark_categories"."kind" = 'custom';--> statement-breakpoint
CREATE INDEX `demo_bookmark_categories_user_idx` ON `demo_bookmark_categories` (`user_id`);--> statement-breakpoint
INSERT INTO `demo_bookmark_categories` (`key`, `name`, `kind`, `user_id`, `created_at`, `updated_at`) VALUES
	('BUTTOCKS_EXPOSED', 'BUTTOCKS_EXPOSED', 'system', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
	('FEMALE_BREAST_EXPOSED', 'FEMALE_BREAST_EXPOSED', 'system', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
	('FEMALE_GENITALIA_EXPOSED', 'FEMALE_GENITALIA_EXPOSED', 'system', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
	('MALE_BREAST_EXPOSED', 'MALE_BREAST_EXPOSED', 'system', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
	('ANUS_EXPOSED', 'ANUS_EXPOSED', 'system', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
	('FEET_EXPOSED', 'FEET_EXPOSED', 'system', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
	('ARMPITS_EXPOSED', 'ARMPITS_EXPOSED', 'system', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
	('BELLY_EXPOSED', 'BELLY_EXPOSED', 'system', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
	('MALE_GENITALIA_EXPOSED', 'MALE_GENITALIA_EXPOSED', 'system', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
	('ANUS_COVERED', 'ANUS_COVERED', 'system', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
	('FEMALE_GENITALIA_COVERED', 'FEMALE_GENITALIA_COVERED', 'system', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT (`key`) WHERE `kind` = 'system'
DO UPDATE SET `name` = excluded.`name`, `updated_at` = CURRENT_TIMESTAMP;--> statement-breakpoint
CREATE TABLE `demo_bookmark_category_assignments` (
	`bookmark_id` integer NOT NULL,
	`category_id` integer NOT NULL,
	`confidence` real,
	`provider_label` text,
	PRIMARY KEY(`bookmark_id`, `category_id`),
	FOREIGN KEY (`bookmark_id`) REFERENCES `demo_bookmarks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `demo_bookmark_categories`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "demo_bookmark_category_assignments_confidence_check" CHECK("demo_bookmark_category_assignments"."confidence" IS NULL OR ("demo_bookmark_category_assignments"."confidence" >= 0 AND "demo_bookmark_category_assignments"."confidence" <= 1))
);
--> statement-breakpoint
CREATE INDEX `demo_bookmark_category_assignments_category_idx` ON `demo_bookmark_category_assignments` (`category_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_demo_bookmarks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`video_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`timestamp_seconds` real NOT NULL,
	`end_timestamp_seconds` real,
	`peak_timestamp_seconds` real,
	`origin` text DEFAULT 'manual' NOT NULL,
	`analysis_run_id` integer,
	`user_modified_at` text,
	`name` text NOT NULL,
	`description` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`video_id`) REFERENCES `demo_videos`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "demo_bookmarks_origin_check" CHECK("__new_demo_bookmarks"."origin" IN ('manual', 'automatic')),
	CONSTRAINT "demo_bookmarks_timestamp_check" CHECK("__new_demo_bookmarks"."timestamp_seconds" >= 0),
	CONSTRAINT "demo_bookmarks_interval_check" CHECK(("__new_demo_bookmarks"."end_timestamp_seconds" IS NULL AND "__new_demo_bookmarks"."peak_timestamp_seconds" IS NULL) OR ("__new_demo_bookmarks"."end_timestamp_seconds" IS NOT NULL AND "__new_demo_bookmarks"."peak_timestamp_seconds" IS NOT NULL AND "__new_demo_bookmarks"."timestamp_seconds" <= "__new_demo_bookmarks"."peak_timestamp_seconds" AND "__new_demo_bookmarks"."peak_timestamp_seconds" <= "__new_demo_bookmarks"."end_timestamp_seconds")),
	CONSTRAINT "demo_bookmarks_provenance_check" CHECK(("__new_demo_bookmarks"."origin" = 'manual' AND "__new_demo_bookmarks"."analysis_run_id" IS NULL) OR ("__new_demo_bookmarks"."origin" = 'automatic' AND "__new_demo_bookmarks"."analysis_run_id" IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO `__new_demo_bookmarks`("id", "video_id", "user_id", "timestamp_seconds", "end_timestamp_seconds", "peak_timestamp_seconds", "origin", "analysis_run_id", "user_modified_at", "name", "description", "created_at", "updated_at") SELECT "id", "video_id", "user_id", "timestamp_seconds", NULL, NULL, 'manual', NULL, NULL, "name", "description", "created_at", "updated_at" FROM `demo_bookmarks`;--> statement-breakpoint
DROP TABLE `demo_bookmarks`;--> statement-breakpoint
ALTER TABLE `__new_demo_bookmarks` RENAME TO `demo_bookmarks`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `demo_bookmarks_origin_idx` ON `demo_bookmarks` (`origin`);--> statement-breakpoint
CREATE INDEX `demo_bookmarks_analysis_run_idx` ON `demo_bookmarks` (`analysis_run_id`);
