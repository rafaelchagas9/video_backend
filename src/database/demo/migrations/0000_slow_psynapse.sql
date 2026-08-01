CREATE TABLE `demo_bookmarks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`video_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`timestamp_seconds` real NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`video_id`) REFERENCES `demo_videos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `demo_collection_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`collection_id` integer NOT NULL,
	`video_id` integer NOT NULL,
	`entry_kind` text NOT NULL,
	`sequence_number` integer,
	`season_number` integer,
	`episode_number` integer,
	`episode_part` integer,
	`absolute_number` integer,
	`display_title_override` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`collection_id`) REFERENCES `demo_collections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`video_id`) REFERENCES `demo_videos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `demo_collection_video_unique` ON `demo_collection_entries` (`video_id`);--> statement-breakpoint
CREATE TABLE `demo_collections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`kind` text NOT NULL,
	`description` text,
	`release_year` integer,
	`external_ids_json` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `demo_creator_aliases` (
	`id` integer NOT NULL,
	`creator_id` integer NOT NULL,
	`name` text NOT NULL,
	`note` text,
	`created_at` text NOT NULL,
	PRIMARY KEY(`creator_id`, `id`),
	FOREIGN KEY (`creator_id`) REFERENCES `demo_creators`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `demo_creator_face_embeddings` (
	`id` integer NOT NULL,
	`creator_id` integer NOT NULL,
	`payload_json` text NOT NULL,
	`thumbnail_path` text,
	`is_primary` integer NOT NULL,
	PRIMARY KEY(`creator_id`, `id`),
	FOREIGN KEY (`creator_id`) REFERENCES `demo_creators`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `demo_creator_favorites` (
	`user_id` integer NOT NULL,
	`creator_id` integer NOT NULL,
	`added_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `creator_id`),
	FOREIGN KEY (`creator_id`) REFERENCES `demo_creators`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `demo_creator_gallery` (
	`id` integer NOT NULL,
	`creator_id` integer NOT NULL,
	`label` text,
	`description` text,
	`file_path` text NOT NULL,
	`is_profile_picture` integer NOT NULL,
	`is_main_picture` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`creator_id`, `id`),
	FOREIGN KEY (`creator_id`) REFERENCES `demo_creators`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `demo_creator_platforms` (
	`id` integer NOT NULL,
	`creator_id` integer NOT NULL,
	`platform_id` integer NOT NULL,
	`platform_name` text NOT NULL,
	`username` text NOT NULL,
	`profile_url` text NOT NULL,
	`is_primary` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`creator_id`, `id`),
	FOREIGN KEY (`creator_id`) REFERENCES `demo_creators`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `demo_creator_social_links` (
	`id` integer NOT NULL,
	`creator_id` integer NOT NULL,
	`platform_name` text NOT NULL,
	`url` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`creator_id`, `id`),
	FOREIGN KEY (`creator_id`) REFERENCES `demo_creators`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `demo_creators` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`profile_picture_path` text,
	`main_picture_path` text,
	`face_thumbnail_path` text,
	`extra_json` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `demo_creators_name_unique` ON `demo_creators` (`name`);--> statement-breakpoint
CREATE TABLE `demo_enrichment_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` integer NOT NULL,
	`status` text NOT NULL,
	`sources_used_json` text NOT NULL,
	`suggestion_count` integer NOT NULL,
	`errors_json` text,
	`started_at` text NOT NULL,
	`finished_at` text
);
--> statement-breakpoint
CREATE TABLE `demo_enrichment_suggestions` (
	`id` integer PRIMARY KEY NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` integer NOT NULL,
	`type` text NOT NULL,
	`field_key` text,
	`value` text NOT NULL,
	`source` text NOT NULL,
	`source_url` text,
	`confidence` real,
	`face_match_score` real,
	`cached_preview_path` text,
	`status` text NOT NULL,
	`dedup_hash` text NOT NULL,
	`raw_json` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `demo_enrichment_suggestions_dedup_hash_unique` ON `demo_enrichment_suggestions` (`dedup_hash`);--> statement-breakpoint
CREATE TABLE `demo_favorites` (
	`user_id` integer NOT NULL,
	`video_id` integer NOT NULL,
	`added_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `video_id`),
	FOREIGN KEY (`video_id`) REFERENCES `demo_videos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `demo_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `demo_playlist_videos` (
	`playlist_id` integer NOT NULL,
	`video_id` integer NOT NULL,
	`position` integer NOT NULL,
	`added_at` text NOT NULL,
	PRIMARY KEY(`playlist_id`, `video_id`),
	FOREIGN KEY (`playlist_id`) REFERENCES `demo_playlists`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`video_id`) REFERENCES `demo_videos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `demo_playlists` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `demo_ratings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`video_id` integer NOT NULL,
	`rating` integer NOT NULL,
	`comment` text,
	`rated_at` text NOT NULL,
	FOREIGN KEY (`video_id`) REFERENCES `demo_videos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `demo_resources` (
	`kind` text NOT NULL,
	`id` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`kind`, `id`)
);
--> statement-breakpoint
CREATE TABLE `demo_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `demo_storyboards` (
	`video_id` integer PRIMARY KEY NOT NULL,
	`sprite_path` text NOT NULL,
	`vtt_path` text NOT NULL,
	`tile_width` integer NOT NULL,
	`tile_height` integer NOT NULL,
	`tile_count` integer NOT NULL,
	`interval_seconds` real NOT NULL,
	`sprite_size_bytes` integer NOT NULL,
	`generated_at` text NOT NULL,
	FOREIGN KEY (`video_id`) REFERENCES `demo_videos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `demo_studio_social_links` (
	`id` integer NOT NULL,
	`studio_id` integer NOT NULL,
	`platform_name` text NOT NULL,
	`url` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`studio_id`, `id`),
	FOREIGN KEY (`studio_id`) REFERENCES `demo_studios`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `demo_studios` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`profile_picture_path` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `demo_studios_name_unique` ON `demo_studios` (`name`);--> statement-breakpoint
CREATE TABLE `demo_tags` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`parent_id` integer,
	`description` text,
	`color` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`parent_id`) REFERENCES `demo_tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `demo_tags_name_parent_unique` ON `demo_tags` (`name`,`parent_id`);--> statement-breakpoint
CREATE INDEX `demo_tags_parent_idx` ON `demo_tags` (`parent_id`);--> statement-breakpoint
CREATE TABLE `demo_thumbnails` (
	`video_id` integer PRIMARY KEY NOT NULL,
	`file_path` text NOT NULL,
	`file_size_bytes` integer NOT NULL,
	`timestamp_seconds` real NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`generated_at` text NOT NULL,
	FOREIGN KEY (`video_id`) REFERENCES `demo_videos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `demo_video_creators` (
	`video_id` integer NOT NULL,
	`creator_id` integer NOT NULL,
	PRIMARY KEY(`video_id`, `creator_id`),
	FOREIGN KEY (`video_id`) REFERENCES `demo_videos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`creator_id`) REFERENCES `demo_creators`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `demo_video_stats` (
	`user_id` integer NOT NULL,
	`video_id` integer NOT NULL,
	`play_count` integer NOT NULL,
	`total_watch_seconds` real NOT NULL,
	`session_watch_seconds` real NOT NULL,
	`session_play_counted` integer NOT NULL,
	`last_position_seconds` real,
	`last_played_at` text,
	`last_watch_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `video_id`),
	FOREIGN KEY (`video_id`) REFERENCES `demo_videos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `demo_video_studios` (
	`video_id` integer NOT NULL,
	`studio_id` integer NOT NULL,
	PRIMARY KEY(`video_id`, `studio_id`),
	FOREIGN KEY (`video_id`) REFERENCES `demo_videos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`studio_id`) REFERENCES `demo_studios`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `demo_video_tags` (
	`video_id` integer NOT NULL,
	`tag_id` integer NOT NULL,
	PRIMARY KEY(`video_id`, `tag_id`),
	FOREIGN KEY (`video_id`) REFERENCES `demo_videos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `demo_tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `demo_videos` (
	`id` integer PRIMARY KEY NOT NULL,
	`source_video_id` integer,
	`file_path` text NOT NULL,
	`file_name` text NOT NULL,
	`directory_id` integer NOT NULL,
	`file_size_bytes` integer NOT NULL,
	`file_hash` text,
	`duration_seconds` real,
	`width` integer,
	`height` integer,
	`codec` text,
	`bitrate` integer,
	`fps` real,
	`audio_codec` text,
	`title` text,
	`description` text,
	`themes` text,
	`is_available` integer NOT NULL,
	`last_verified_at` text,
	`indexed_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `demo_videos_source_idx` ON `demo_videos` (`source_video_id`);