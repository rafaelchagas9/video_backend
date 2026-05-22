ALTER TABLE "conversion_history" ALTER COLUMN "original_size_bytes" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "conversion_history" ALTER COLUMN "output_size_bytes" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "conversion_history" ALTER COLUMN "size_delta_bytes" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "conversion_jobs" ALTER COLUMN "output_size_bytes" SET DATA TYPE bigint;