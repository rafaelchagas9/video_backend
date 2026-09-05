ALTER TABLE "videos" ALTER COLUMN "file_size_bytes" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "artwork_assets" ALTER COLUMN "file_size_bytes" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "storyboards" ALTER COLUMN "sprite_size_bytes" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "thumbnails" ALTER COLUMN "file_size_bytes" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "stats_library_snapshots" ALTER COLUMN "total_size_bytes" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "stats_library_snapshots" ALTER COLUMN "average_size_bytes" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "stats_storage_snapshots" ALTER COLUMN "total_video_size_bytes" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "stats_storage_snapshots" ALTER COLUMN "thumbnails_size_bytes" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "stats_storage_snapshots" ALTER COLUMN "storyboards_size_bytes" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "stats_storage_snapshots" ALTER COLUMN "profile_pictures_size_bytes" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "stats_storage_snapshots" ALTER COLUMN "converted_size_bytes" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "stats_storage_snapshots" ALTER COLUMN "faces_size_bytes" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "stats_storage_snapshots" ALTER COLUMN "database_size_bytes" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "face_images" ALTER COLUMN "file_size_bytes" SET DATA TYPE bigint;