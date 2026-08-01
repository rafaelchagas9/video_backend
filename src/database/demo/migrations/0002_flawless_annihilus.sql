CREATE TABLE `demo_artwork_assets` (
	`id` integer PRIMARY KEY NOT NULL,
	`video_id` integer NOT NULL,
	`variant` text NOT NULL,
	`content_hash` text NOT NULL,
	`file_path` text NOT NULL,
	`file_size_bytes` integer NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`source_timestamp_seconds` real,
	`crop_json` text,
	`focal_point_json` text,
	`safe_area_json` text,
	`bottom_luma` real,
	`thumbhash` text,
	`effects_json` text NOT NULL,
	`generated_at` text NOT NULL,
	FOREIGN KEY (`video_id`) REFERENCES `demo_videos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `demo_artwork_video_variant_unique` ON `demo_artwork_assets` (`video_id`,`variant`);--> statement-breakpoint
CREATE TABLE `demo_artwork` (
	`video_id` integer PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`status` text NOT NULL,
	`palette_json` text,
	`generated_at` text,
	FOREIGN KEY (`video_id`) REFERENCES `demo_videos`(`id`) ON UPDATE no action ON DELETE cascade
);
