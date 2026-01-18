CREATE TABLE IF NOT EXISTS "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now(),
	FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "watched_directories" (
	"id" serial PRIMARY KEY NOT NULL,
	"path" text NOT NULL,
	"is_active" boolean DEFAULT true,
	"auto_scan" boolean DEFAULT true,
	"scan_interval_minutes" integer DEFAULT 30,
	"last_scan_at" timestamp,
	"added_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "watched_directories_path_unique" UNIQUE("path")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "videos" (
	"id" serial PRIMARY KEY NOT NULL,
	"file_path" text NOT NULL,
	"file_name" text NOT NULL,
	"directory_id" integer NOT NULL,
	"file_size_bytes" integer NOT NULL,
	"file_hash" text,
	"duration_seconds" real,
	"width" integer,
	"height" integer,
	"codec" text,
	"bitrate" integer,
	"fps" real,
	"audio_codec" text,
	"title" text,
	"description" text,
	"themes" text,
	"is_available" boolean DEFAULT true,
	"last_verified_at" timestamp,
	"indexed_at" timestamp DEFAULT now(),
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	FOREIGN KEY ("directory_id") REFERENCES "watched_directories"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "videos_file_path_unique" UNIQUE("file_path")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "video_stats" (
	"user_id" integer NOT NULL,
	"video_id" integer NOT NULL,
	"play_count" integer DEFAULT 0,
	"total_watch_seconds" real DEFAULT 0,
	"session_watch_seconds" real DEFAULT 0,
	"session_play_counted" boolean DEFAULT false,
	"last_position_seconds" real,
	"last_played_at" timestamp,
	"last_watch_at" timestamp,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	PRIMARY KEY ("user_id", "video_id"),
	FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action,
	FOREIGN KEY ("video_id") REFERENCES "videos"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "creators" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "creators_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "video_creators" (
	"video_id" integer NOT NULL,
	"creator_id" integer NOT NULL,
	PRIMARY KEY ("video_id", "creator_id"),
	FOREIGN KEY ("video_id") REFERENCES "videos"("id") ON DELETE cascade ON UPDATE no action,
	FOREIGN KEY ("creator_id") REFERENCES "creators"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tags" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"parent_id" integer,
	"description" text,
	"color" text,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	FOREIGN KEY ("parent_id") REFERENCES "tags"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "tags_name_parent_id_unique" UNIQUE("name", "parent_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "video_tags" (
	"video_id" integer NOT NULL,
	"tag_id" integer NOT NULL,
	PRIMARY KEY ("video_id", "tag_id"),
	FOREIGN KEY ("video_id") REFERENCES "videos"("id") ON DELETE cascade ON UPDATE no action,
	FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ratings" (
	"id" serial PRIMARY KEY NOT NULL,
	"video_id" integer NOT NULL,
	"rating" integer NOT NULL,
	"comment" text,
	"rated_at" timestamp DEFAULT now(),
	FOREIGN KEY ("video_id") REFERENCES "videos"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "video_metadata" (
	"id" serial PRIMARY KEY NOT NULL,
	"video_id" integer NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	FOREIGN KEY ("video_id") REFERENCES "videos"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "video_metadata_video_id_key_unique" UNIQUE("video_id", "key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "thumbnails" (
	"id" serial PRIMARY KEY NOT NULL,
	"video_id" integer NOT NULL,
	"file_path" text NOT NULL,
	"file_size_bytes" integer,
	"timestamp_seconds" real DEFAULT 5.0,
	"width" integer,
	"height" integer,
	"generated_at" timestamp DEFAULT now(),
	FOREIGN KEY ("video_id") REFERENCES "videos"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "thumbnails_video_id_unique" UNIQUE("video_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "playlists" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "playlist_videos" (
	"playlist_id" integer NOT NULL,
	"video_id" integer NOT NULL,
	"position" integer NOT NULL,
	"added_at" timestamp DEFAULT now(),
	PRIMARY KEY ("playlist_id", "video_id"),
	FOREIGN KEY ("playlist_id") REFERENCES "playlists"("id") ON DELETE cascade ON UPDATE no action,
	FOREIGN KEY ("video_id") REFERENCES "videos"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "favorites" (
	"user_id" integer NOT NULL,
	"video_id" integer NOT NULL,
	"added_at" timestamp DEFAULT now(),
	PRIMARY KEY ("user_id", "video_id"),
	FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action,
	FOREIGN KEY ("video_id") REFERENCES "videos"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bookmarks" (
	"id" serial PRIMARY KEY NOT NULL,
	"video_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"timestamp_seconds" real NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	FOREIGN KEY ("video_id") REFERENCES "videos"("id") ON DELETE cascade ON UPDATE no action,
	FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scan_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"directory_id" integer NOT NULL,
	"files_found" integer DEFAULT 0,
	"files_added" integer DEFAULT 0,
	"files_updated" integer DEFAULT 0,
	"files_removed" integer DEFAULT 0,
	"errors" text,
	"started_at" timestamp NOT NULL,
	"completed_at" timestamp,
	FOREIGN KEY ("directory_id") REFERENCES "watched_directories"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "conversion_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"video_id" integer NOT NULL,
	"status" text NOT NULL,
	"preset" text NOT NULL,
	"target_resolution" text,
	"codec" text NOT NULL,
	"output_path" text,
	"output_size_bytes" integer,
	"progress_percent" integer DEFAULT 0,
	"error_message" text,
	"delete_original" boolean DEFAULT false,
	"batch_id" text,
	"started_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now(),
	FOREIGN KEY ("video_id") REFERENCES "videos"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stats_storage_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"total_video_size_bytes" integer NOT NULL,
	"total_video_count" integer NOT NULL,
	"thumbnails_size_bytes" integer DEFAULT 0 NOT NULL,
	"storyboards_size_bytes" integer DEFAULT 0 NOT NULL,
	"profile_pictures_size_bytes" integer DEFAULT 0 NOT NULL,
	"converted_size_bytes" integer DEFAULT 0 NOT NULL,
	"database_size_bytes" integer DEFAULT 0 NOT NULL,
	"directory_breakdown" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stats_library_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"total_video_count" integer NOT NULL,
	"available_video_count" integer NOT NULL,
	"unavailable_video_count" integer NOT NULL,
	"total_size_bytes" integer NOT NULL,
	"average_size_bytes" integer NOT NULL,
	"total_duration_seconds" real NOT NULL,
	"average_duration_seconds" real NOT NULL,
	"resolution_breakdown" text,
	"codec_breakdown" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stats_content_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"videos_without_tags" integer NOT NULL,
	"videos_without_creators" integer NOT NULL,
	"videos_without_ratings" integer NOT NULL,
	"videos_without_thumbnails" integer NOT NULL,
	"videos_without_storyboards" integer NOT NULL,
	"total_tags" integer NOT NULL,
	"total_creators" integer NOT NULL,
	"total_studios" integer NOT NULL,
	"total_playlists" integer NOT NULL,
	"top_tags" text,
	"top_creators" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stats_usage_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"total_watch_time_seconds" real NOT NULL,
	"total_play_count" integer NOT NULL,
	"unique_videos_watched" integer NOT NULL,
	"videos_never_watched" integer NOT NULL,
	"average_completion_rate" real,
	"top_watched" text,
	"activity_by_hour" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
INSERT INTO "app_settings" ("key", "value") VALUES
	('min_watch_seconds', '60'),
	('short_video_watch_seconds', '10'),
	('short_video_duration_seconds', '60'),
	('downscale_inactive_days', '90'),
	('watch_session_gap_minutes', '30'),
	('max_suggestions', '200')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sessions_user" ON "sessions" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sessions_expires" ON "sessions" USING btree ("expires_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_videos_directory" ON "videos" USING btree ("directory_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_videos_file_path" ON "videos" USING btree ("file_path");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_videos_file_hash" ON "videos" USING btree ("file_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_video_stats_video" ON "video_stats" USING btree ("video_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_video_stats_user" ON "video_stats" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_video_stats_last_played" ON "video_stats" USING btree ("last_played_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_video_creators_video" ON "video_creators" USING btree ("video_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_video_creators_creator" ON "video_creators" USING btree ("creator_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tags_parent" ON "tags" USING btree ("parent_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_video_tags_video" ON "video_tags" USING btree ("video_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_video_tags_tag" ON "video_tags" USING btree ("tag_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ratings_video" ON "ratings" USING btree ("video_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_video_metadata_video" ON "video_metadata" USING btree ("video_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_video_metadata_key" ON "video_metadata" USING btree ("key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_thumbnails_video" ON "thumbnails" USING btree ("video_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_playlist_videos_playlist" ON "playlist_videos" USING btree ("playlist_id", "position");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_favorites_user" ON "favorites" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_bookmarks_video" ON "bookmarks" USING btree ("video_id", "timestamp_seconds");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_bookmarks_user" ON "bookmarks" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_scan_logs_directory" ON "scan_logs" USING btree ("directory_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_scan_logs_started" ON "scan_logs" USING btree ("started_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_conversion_jobs_video" ON "conversion_jobs" USING btree ("video_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_conversion_jobs_status" ON "conversion_jobs" USING btree ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_conversion_jobs_batch" ON "conversion_jobs" USING btree ("batch_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_stats_storage_created" ON "stats_storage_snapshots" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_stats_library_created" ON "stats_library_snapshots" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_stats_content_created" ON "stats_content_snapshots" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_stats_usage_created" ON "stats_usage_snapshots" USING btree ("created_at");
