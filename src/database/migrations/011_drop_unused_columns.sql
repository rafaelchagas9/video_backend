-- Drop unused legacy columns that were not migrated to Drizzle schema
-- These columns exist in the database but are not used by the application

ALTER TABLE videos DROP COLUMN IF EXISTS is_deleted;
ALTER TABLE studios DROP COLUMN IF EXISTS is_verified;
ALTER TABLE creators DROP COLUMN IF EXISTS is_verified;
ALTER TABLE conversion_jobs DROP COLUMN IF EXISTS is_deleted;
ALTER TABLE thumbnails DROP COLUMN IF EXISTS auto_generated;
