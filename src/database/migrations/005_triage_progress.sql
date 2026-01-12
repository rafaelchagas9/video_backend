-- Migration: 005 - Triage Progress Tracking
-- Description: Add triage_progress table for server-side persistence of triage session progress

CREATE TABLE IF NOT EXISTS triage_progress (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    filter_key TEXT NOT NULL,
    last_video_id INTEGER,
    processed_count INTEGER DEFAULT 0,
    total_count INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (last_video_id) REFERENCES videos(id) ON DELETE SET NULL,
    UNIQUE(user_id, filter_key)
);

CREATE INDEX IF NOT EXISTS idx_triage_progress_user ON triage_progress(user_id);
CREATE INDEX IF NOT EXISTS idx_triage_progress_filter ON triage_progress(user_id, filter_key);
