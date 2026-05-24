CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_videos_title_trgm ON videos USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_videos_description_trgm ON videos USING gin (description gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_videos_file_name_trgm ON videos USING gin (file_name gin_trgm_ops);
