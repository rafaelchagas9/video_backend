#!/usr/bin/env bun
import { z } from "zod";

const envSchema = z.object({
  // Server
  PORT: z.string().default("3000").transform(Number),
  HOST: z.string().default("localhost"),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  BASE_URL: z.string().default("http://localhost:3000"),

  // Database (SQLite - deprecated, keeping for backward compatibility)
  DATABASE_PATH: z.string().default("./data/database.db"),

  // PostgreSQL Database
  POSTGRES_HOST: z.string().default("localhost"),
  POSTGRES_PORT: z.string().default("5432").transform(Number),
  POSTGRES_DB: z.string().default("video_streaming_db"),
  POSTGRES_USER: z.string(),
  POSTGRES_PASSWORD: z.string(),
  POSTGRES_MAX_CONNECTIONS: z.string().default("20").transform(Number),

  // Paths
  THUMBNAILS_DIR: z.string().default("./data/thumbnails"),
  PROFILE_PICTURES_DIR: z.string().default("./data/profile-pictures"),
  LOGS_DIR: z.string().default("./logs"),

  // Authentication
  SESSION_SECRET: z
    .string()
    .min(32, "Session secret must be at least 32 characters"),
  SESSION_EXPIRY_HOURS: z.string().default("168").transform(Number),

  // Video Processing
  FFMPEG_PATH: z.string().default("/usr/bin/ffmpeg"),
  FFPROBE_PATH: z.string().default("/usr/bin/ffprobe"),
  THUMBNAIL_SIZE: z.string().default("320x180"),
  THUMBNAIL_TIMESTAMP: z.string().default("5.0").transform(Number),
  THUMBNAIL_FORMAT: z.enum(["webp", "jpg"]).default("webp"),
  THUMBNAIL_QUALITY: z
    .string()
    .default("75")
    .transform(Number)
    .pipe(z.number().min(1).max(100)),
  THUMBNAIL_POSITION_PERCENT: z
    .string()
    .default("20")
    .transform(Number)
    .pipe(z.number().min(0).max(100)),
  PROFILE_PICTURE_MAX_SIZE: z.string().default("1080").transform(Number),
  PROFILE_PICTURE_FORMAT: z.enum(["webp", "jpg"]).default("webp"),
  PROFILE_PICTURE_QUALITY: z
    .string()
    .default("80")
    .transform(Number)
    .pipe(z.number().min(1).max(100)),
  FACE_THUMBNAIL_SIZE: z.string().default("320").transform(Number),
  FACE_THUMBNAIL_FORMAT: z.enum(["webp", "jpg"]).default("webp"),
  FACE_THUMBNAIL_QUALITY: z
    .string()
    .default("80")
    .transform(Number)
    .pipe(z.number().min(1).max(100)),

  // Storyboard (Vidstack slider thumbnails)
  STORYBOARDS_DIR: z.string().default("./data/storyboards"),
  STORYBOARD_TILE_WIDTH: z.string().default("192").transform(Number),
  STORYBOARD_TILE_HEIGHT: z.string().default("108").transform(Number),
  STORYBOARD_INTERVAL_SECONDS: z.string().default("6").transform(Number),
  STORYBOARD_FORMAT: z.enum(["webp", "jpg"]).default("webp"),
  STORYBOARD_QUALITY: z
    .string()
    .default("70")
    .transform(Number)
    .pipe(z.number().min(1).max(100)),

  // File Scanning
  DEFAULT_SCAN_INTERVAL_MINUTES: z.string().default("30").transform(Number),
  MAX_FILE_SIZE_GB: z.string().default("50").transform(Number),

  // GPU Acceleration (VAAPI for AMD)
  VAAPI_DEVICE: z.string().default("/dev/dri/renderD128"),
  CONVERTED_VIDEOS_DIR: z.string().default("./data/converted"),

  // Redis (for job queue)
  REDIS_URL: z.string().default("redis://localhost:6379"),

  // Conversion
  CONVERSION_MAX_CONCURRENT: z.string().default("1").transform(Number),

  // Telemetry
  POSTHOG_API_KEY: z.string().default(""),
  POSTHOG_HOST: z.string().default("https://us.i.posthog.com"),
  POSTHOG_LOG_LEVEL: z
    .enum(["debug", "info", "warn", "error", "fatal"])
    .default("warn"),
  POSTHOG_CAPTURE_REQUEST_METRICS: z
    .string()
    .default("true")
    .transform((value) => value.toLowerCase() === "true"),

  // Face Recognition
  FACE_SERVICE_URL: z.string().default("http://localhost:8100"),
  FACE_SIMILARITY_THRESHOLD: z
    .string()
    .default("0.65")
    .transform(Number)
    .pipe(z.number().min(0).max(1)),
  FACE_AUTO_TAG_THRESHOLD: z
    .string()
    .default("0.75")
    .transform(Number)
    .pipe(z.number().min(0).max(1)),
  FACE_DETECTION_BATCH_SIZE: z.string().default("10").transform(Number),
  FACE_DETECTION_RETRY_INTERVAL_MS: z
    .string()
    .default("300000")
    .transform(Number),
  FACE_DETECTION_MAX_RETRIES: z.string().default("3").transform(Number),

  // Frame Extraction
  FRAME_EXTRACTION_TEMP_DIR: z.string().default("/dev/shm"),
  FRAME_EXTRACTION_FORMAT: z.enum(["jpg", "webp", "png"]).default("jpg"),
  FRAME_EXTRACTION_QUALITY: z
    .string()
    .default("90")
    .transform(Number)
    .pipe(z.number().min(1).max(100)),
});

async function main() {
  console.log("🔍 Validating environment variables...\n");

  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error("❌ Invalid environment variables:\n");
    const formattedErrors = result.error.format();

    for (const [key, error] of Object.entries(formattedErrors)) {
      if (key === "_errors") continue;
      if (error && typeof error === "object" && "_errors" in error) {
        const errors = error._errors;
        if (errors && errors.length > 0) {
          console.error(`   ${key}: ${errors.join(", ")}`);
        }
      }
    }

    console.error("\n⚠️  Please fix the issues above before continuing.");
    process.exit(1);
  }

  console.log("✅ All environment variables are valid!");

  const env = result.data;

  console.log(`\n📋 Configuration:`);
  console.log(`   NODE_ENV: ${env.NODE_ENV}`);
  console.log(
    `   PostgreSQL: ${env.POSTGRES_USER}@${env.POSTGRES_HOST}:${env.POSTGRES_PORT}/${env.POSTGRES_DB}`,
  );
  console.log(`   Server: ${env.HOST}:${env.PORT}`);
  console.log(`   Session Secret: ${env.SESSION_SECRET.length} characters ✓`);
  console.log(
    `   PostHog: ${env.POSTHOG_API_KEY.length > 0 ? env.POSTHOG_HOST : "disabled"}`,
  );

  if (env.SESSION_SECRET === "change-this-to-a-random-secret-in-production") {
    console.error(
      "\n⚠️  WARNING: Default session secret detected! Change SESSION_SECRET in production!",
    );
    process.exit(1);
  }

  console.log("\n✨ Environment validation passed!");
  process.exit(0);
}

main();
