-- Migration: 002_conversion_jobs
-- Created: 2026-01-09
-- Description: Add conversion_jobs table for video transcoding queue

CREATE TABLE IF NOT EXISTS conversion_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- pending, processing, completed, failed, cancelled
    preset TEXT NOT NULL, -- '1080p_h264', '720p_h265', '720p_av1', etc.
    target_resolution TEXT, -- '1920x1080', '1280x720', or 'original'
    codec TEXT NOT NULL, -- h264_vaapi, hevc_vaapi, av1_vaapi
    output_path TEXT,
    output_size_bytes INTEGER,
    progress_percent REAL DEFAULT 0,
    error_message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    started_at DATETIME,
    completed_at DATETIME,
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_conversion_jobs_video ON conversion_jobs(video_id);
CREATE INDEX IF NOT EXISTS idx_conversion_jobs_status ON conversion_jobs(status);
