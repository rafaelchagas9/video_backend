import { z } from 'zod';

const envSchema = z.object({
  // Server
  PORT: z.string().default('3000').transform(Number),
  HOST: z.string().default('localhost'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // Database
  DATABASE_PATH: z.string().default('./data/database.db'),

  // Paths
  THUMBNAILS_DIR: z.string().default('./data/thumbnails'),
  LOGS_DIR: z.string().default('./logs'),

  // Authentication
  SESSION_SECRET: z.string().min(32, 'Session secret must be at least 32 characters'),
  SESSION_EXPIRY_HOURS: z.string().default('168').transform(Number),

  // Video Processing
  FFMPEG_PATH: z.string().default('/usr/bin/ffmpeg'),
  FFPROBE_PATH: z.string().default('/usr/bin/ffprobe'),
  THUMBNAIL_SIZE: z.string().default('320x240'),
  THUMBNAIL_TIMESTAMP: z.string().default('5.0').transform(Number),

  // File Scanning
  DEFAULT_SCAN_INTERVAL_MINUTES: z.string().default('30').transform(Number),
  MAX_FILE_SIZE_GB: z.string().default('50').transform(Number),
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
