import { z } from 'zod';

const envSchema = z.object({
  // Server
  PORT: z.string().default('3000').transform(Number),
  HOST: z.string().default('localhost'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  BASE_URL: z.string().default('http://localhost:3000'),

  // Database
  DATABASE_PATH: z.string().default('./data/database.db'),

  // Paths
  THUMBNAILS_DIR: z.string().default('./data/thumbnails'),
  PROFILE_PICTURES_DIR: z.string().default('./data/profile-pictures'),
  LOGS_DIR: z.string().default('./logs'),

  // Authentication
  SESSION_SECRET: z.string().min(32, 'Session secret must be at least 32 characters'),
  SESSION_EXPIRY_HOURS: z.string().default('168').transform(Number),

  // Video Processing
  FFMPEG_PATH: z.string().default('/usr/bin/ffmpeg'),
  FFPROBE_PATH: z.string().default('/usr/bin/ffprobe'),
  THUMBNAIL_SIZE: z.string().default('320x240'),
  THUMBNAIL_TIMESTAMP: z.string().default('5.0').transform(Number),
  THUMBNAIL_FORMAT: z.enum(['webp', 'jpg']).default('webp'),
  THUMBNAIL_QUALITY: z.string().default('80').transform(Number).pipe(z.number().min(1).max(100)),
  THUMBNAIL_POSITION_PERCENT: z.string().default('20').transform(Number).pipe(z.number().min(0).max(100)),

  // Storyboard (Vidstack slider thumbnails)
  STORYBOARDS_DIR: z.string().default('./data/storyboards'),
  STORYBOARD_TILE_WIDTH: z.string().default('256').transform(Number),
  STORYBOARD_TILE_HEIGHT: z.string().default('144').transform(Number),
  STORYBOARD_INTERVAL_SECONDS: z.string().default('5').transform(Number),

  // File Scanning
  DEFAULT_SCAN_INTERVAL_MINUTES: z.string().default('30').transform(Number),
  MAX_FILE_SIZE_GB: z.string().default('50').transform(Number),

  // GPU Acceleration (VAAPI for AMD)
  VAAPI_DEVICE: z.string().default('/dev/dri/renderD128'),
  CONVERTED_VIDEOS_DIR: z.string().default('./data/converted'),

  // Redis (for job queue)
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // Conversion
  CONVERSION_MAX_CONCURRENT: z.string().default('2').transform(Number),
});

function loadEnv() {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error('Invalid environment variables:');
    console.error(result.error.format());
    process.exit(1);
  }

  return result.data;
}

export const env = loadEnv();
export type Env = z.infer<typeof envSchema>;
