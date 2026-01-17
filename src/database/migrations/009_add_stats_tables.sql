-- Storage statistics snapshots (hourly)
CREATE TABLE IF NOT EXISTS stats_storage_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    
    -- Total video storage from database
    total_video_size_bytes INTEGER NOT NULL,
    total_video_count INTEGER NOT NULL,
    
    -- Directory sizes (stored as JSON for flexibility)
    thumbnails_size_bytes INTEGER NOT NULL DEFAULT 0,
    storyboards_size_bytes INTEGER NOT NULL DEFAULT 0,
    profile_pictures_size_bytes INTEGER NOT NULL DEFAULT 0,
    converted_size_bytes INTEGER NOT NULL DEFAULT 0,
    database_size_bytes INTEGER NOT NULL DEFAULT 0,
    
    -- Per watched directory breakdown (JSON array)
    directory_breakdown TEXT,
    
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_stats_storage_created ON stats_storage_snapshots(created_at);

-- Library statistics snapshots (daily)
CREATE TABLE IF NOT EXISTS stats_library_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    
    -- Video counts
    total_video_count INTEGER NOT NULL,
    available_video_count INTEGER NOT NULL,
    unavailable_video_count INTEGER NOT NULL,
    
    -- Storage
    total_size_bytes INTEGER NOT NULL,
    average_size_bytes INTEGER NOT NULL,
    
    -- Duration
    total_duration_seconds REAL NOT NULL,
    average_duration_seconds REAL NOT NULL,
    
    -- Technical breakdown (JSON)
    resolution_breakdown TEXT,
    codec_breakdown TEXT,
    
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_stats_library_created ON stats_library_snapshots(created_at);

-- Content organization statistics snapshots (daily)
CREATE TABLE IF NOT EXISTS stats_content_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    
    -- Organization gaps
    videos_without_tags INTEGER NOT NULL,
    videos_without_creators INTEGER NOT NULL,
    videos_without_ratings INTEGER NOT NULL,
    videos_without_thumbnails INTEGER NOT NULL,
    videos_without_storyboards INTEGER NOT NULL,
    
    -- Entity counts
    total_tags INTEGER NOT NULL,
    total_creators INTEGER NOT NULL,
    total_studios INTEGER NOT NULL,
    total_playlists INTEGER NOT NULL,
    
    -- Top items (JSON arrays)
    top_tags TEXT,
    top_creators TEXT,
    
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_stats_content_created ON stats_content_snapshots(created_at);

-- Usage/watch statistics snapshots (daily)
CREATE TABLE IF NOT EXISTS stats_usage_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    
    -- Watch stats
    total_watch_time_seconds REAL NOT NULL,
    total_play_count INTEGER NOT NULL,
    unique_videos_watched INTEGER NOT NULL,
    videos_never_watched INTEGER NOT NULL,
    
    -- Averages
    average_completion_rate REAL,
    
    -- Top watched (JSON array)
    top_watched TEXT,
    
    -- Activity by hour (JSON object with 0-23 keys)
    activity_by_hour TEXT,
    
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_stats_usage_created ON stats_usage_snapshots(created_at);
