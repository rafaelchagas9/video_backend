-- Migration: Add indexes for attribute-based filtering
-- Description: Adds indexes to improve performance of video and creator filtering queries
-- Created: 2026-01-09

-- Video attribute indexes for filtering
CREATE INDEX IF NOT EXISTS idx_videos_resolution ON videos(width, height);
CREATE INDEX IF NOT EXISTS idx_videos_filesize ON videos(file_size_bytes);
CREATE INDEX IF NOT EXISTS idx_videos_duration ON videos(duration_seconds);
CREATE INDEX IF NOT EXISTS idx_videos_codec ON videos(codec);
CREATE INDEX IF NOT EXISTS idx_videos_audio_codec ON videos(audio_codec);
CREATE INDEX IF NOT EXISTS idx_videos_bitrate ON videos(bitrate);
CREATE INDEX IF NOT EXISTS idx_videos_fps ON videos(fps);
CREATE INDEX IF NOT EXISTS idx_videos_availability ON videos(is_available);

-- Creator name index for search filtering
CREATE INDEX IF NOT EXISTS idx_creators_name ON creators(name);

-- Video-studio relationship indexes (if not already exist)
CREATE INDEX IF NOT EXISTS idx_video_studios_video ON video_studios(video_id);
CREATE INDEX IF NOT EXISTS idx_video_studios_studio ON video_studios(studio_id);
