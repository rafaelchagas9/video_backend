-- Migration: 008_fix_duration_seconds_type
-- Description: Normalize stored duration_seconds values to REAL

UPDATE videos
SET duration_seconds = CAST(duration_seconds AS REAL)
WHERE duration_seconds IS NOT NULL
  AND typeof(duration_seconds) = 'text';
