-- Users table (single user, but structured for potential expansion)
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Sessions table (session-based authentication)
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- Watched directories
CREATE TABLE IF NOT EXISTS watched_directories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL UNIQUE,
    is_active BOOLEAN DEFAULT 1,
    auto_scan BOOLEAN DEFAULT 1,
    scan_interval_minutes INTEGER DEFAULT 30,
    last_scan_at DATETIME,
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Videos table (core media information)
CREATE TABLE IF NOT EXISTS videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path TEXT NOT NULL UNIQUE,
    file_name TEXT NOT NULL,
    directory_id INTEGER NOT NULL,

    -- File metadata
    file_size_bytes INTEGER NOT NULL,
    file_hash TEXT,

    -- Video metadata (extracted)
    duration_seconds REAL,
    width INTEGER,
    height INTEGER,
    codec TEXT,
    bitrate INTEGER,
    fps REAL,
    audio_codec TEXT,

    -- User-editable metadata
    title TEXT,
    description TEXT,
    themes TEXT,

    -- Status tracking
    is_available BOOLEAN DEFAULT 1,
    last_verified_at DATETIME,
    indexed_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (directory_id) REFERENCES watched_directories(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_videos_directory ON videos(directory_id);
CREATE INDEX IF NOT EXISTS idx_videos_file_path ON videos(file_path);
CREATE INDEX IF NOT EXISTS idx_videos_file_hash ON videos(file_hash);

-- Video statistics (per-user watch data)
CREATE TABLE IF NOT EXISTS video_stats (
    user_id INTEGER NOT NULL,
    video_id INTEGER NOT NULL,
    play_count INTEGER DEFAULT 0,
    total_watch_seconds REAL DEFAULT 0,
    session_watch_seconds REAL DEFAULT 0,
    session_play_counted BOOLEAN DEFAULT 0,
    last_position_seconds REAL,
    last_played_at DATETIME,
    last_watch_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (user_id, video_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_video_stats_video ON video_stats(video_id);
CREATE INDEX IF NOT EXISTS idx_video_stats_user ON video_stats(user_id);
CREATE INDEX IF NOT EXISTS idx_video_stats_last_played ON video_stats(last_played_at);

-- App settings
CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO app_settings (key, value) VALUES
    ('min_watch_seconds', '60'),
    ('short_video_watch_seconds', '10'),
    ('short_video_duration_seconds', '60'),
    ('downscale_inactive_days', '90'),
    ('watch_session_gap_minutes', '30'),
    ('max_suggestions', '200');

-- Creators table
CREATE TABLE IF NOT EXISTS creators (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Video-Creator relationship (many-to-many)
CREATE TABLE IF NOT EXISTS video_creators (
    video_id INTEGER NOT NULL,
    creator_id INTEGER NOT NULL,
    PRIMARY KEY (video_id, creator_id),
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
    FOREIGN KEY (creator_id) REFERENCES creators(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_video_creators_video ON video_creators(video_id);
CREATE INDEX IF NOT EXISTS idx_video_creators_creator ON video_creators(creator_id);

-- Hierarchical tags (self-referencing for parent/child)
CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    -- Configuration
    -- target_resolution TEXT,
    -- codec TEXT NOT NULL,
    -- delete_original BOOLEAN DEFAULT 0,
    -- batch_id TEXT,
    parent_id INTEGER,
    description TEXT,
    color TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (parent_id) REFERENCES tags(id) ON DELETE CASCADE,
    UNIQUE(name, parent_id)
);

CREATE INDEX IF NOT EXISTS idx_tags_parent ON tags(parent_id);

-- Video-Tag relationship (many-to-many)
CREATE TABLE IF NOT EXISTS video_tags (
    video_id INTEGER NOT NULL,
    tag_id INTEGER NOT NULL,
    PRIMARY KEY (video_id, tag_id),
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
    FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_video_tags_video ON video_tags(video_id);
CREATE INDEX IF NOT EXISTS idx_video_tags_tag ON video_tags(tag_id);

-- Ratings table
CREATE TABLE IF NOT EXISTS ratings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id INTEGER NOT NULL,
    rating INTEGER NOT NULL CHECK(rating >= 1 AND rating <= 5),
    comment TEXT,
    rated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ratings_video ON ratings(video_id);

-- Custom metadata (arbitrary key-value pairs)
CREATE TABLE IF NOT EXISTS video_metadata (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id INTEGER NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
    UNIQUE(video_id, key)
);

CREATE INDEX IF NOT EXISTS idx_video_metadata_video ON video_metadata(video_id);
CREATE INDEX IF NOT EXISTS idx_video_metadata_key ON video_metadata(key);

-- Thumbnails tracking
CREATE TABLE IF NOT EXISTS thumbnails (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id INTEGER NOT NULL UNIQUE,
    file_path TEXT NOT NULL,
    file_size_bytes INTEGER,
    timestamp_seconds REAL DEFAULT 5.0,
    width INTEGER,
    height INTEGER,
    generated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_thumbnails_video ON thumbnails(video_id);

-- Playlists
CREATE TABLE IF NOT EXISTS playlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS playlist_videos (
    playlist_id INTEGER NOT NULL,
    video_id INTEGER NOT NULL,
    position INTEGER NOT NULL,
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (playlist_id, video_id),
    FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_playlist_videos_playlist ON playlist_videos(playlist_id, position);

-- Favorites
CREATE TABLE IF NOT EXISTS favorites (
    user_id INTEGER NOT NULL,
    video_id INTEGER NOT NULL,
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (user_id, video_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_favorites_user ON favorites(user_id);

-- Bookmarks
CREATE TABLE IF NOT EXISTS bookmarks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    timestamp_seconds REAL NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_bookmarks_video ON bookmarks(video_id, timestamp_seconds);
CREATE INDEX IF NOT EXISTS idx_bookmarks_user ON bookmarks(user_id);

-- Scan history/logs
CREATE TABLE IF NOT EXISTS scan_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    directory_id INTEGER NOT NULL,
    files_found INTEGER DEFAULT 0,
    files_added INTEGER DEFAULT 0,
    files_updated INTEGER DEFAULT 0,
    files_removed INTEGER DEFAULT 0,
    errors TEXT,
    started_at DATETIME NOT NULL,
    completed_at DATETIME,

    FOREIGN KEY (directory_id) REFERENCES watched_directories(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_scan_logs_directory ON scan_logs(directory_id);
CREATE INDEX IF NOT EXISTS idx_scan_logs_started ON scan_logs(started_at);

-- Conversion Jobs
CREATE TABLE IF NOT EXISTS conversion_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id INTEGER NOT NULL,
    status TEXT NOT NULL, -- pending, processing, completed, failed, cancelled
    preset TEXT NOT NULL,
    target_resolution TEXT,
    codec TEXT NOT NULL,
    output_path TEXT,
    output_size_bytes INTEGER,
    progress_percent INTEGER DEFAULT 0,
    error_message TEXT,
    
    -- Configuration
    delete_original BOOLEAN DEFAULT 0,
    batch_id TEXT,

    started_at DATETIME,
    completed_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_conversion_jobs_video ON conversion_jobs(video_id);
CREATE INDEX IF NOT EXISTS idx_conversion_jobs_status ON conversion_jobs(status);
CREATE INDEX IF NOT EXISTS idx_conversion_jobs_batch ON conversion_jobs(batch_id);

-- Storage statistics snapshots (hourly)
CREATE TABLE IF NOT EXISTS stats_storage_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    total_video_size_bytes INTEGER NOT NULL,
    total_video_count INTEGER NOT NULL,
    thumbnails_size_bytes INTEGER NOT NULL DEFAULT 0,
    storyboards_size_bytes INTEGER NOT NULL DEFAULT 0,
    profile_pictures_size_bytes INTEGER NOT NULL DEFAULT 0,
    converted_size_bytes INTEGER NOT NULL DEFAULT 0,
    database_size_bytes INTEGER NOT NULL DEFAULT 0,
    directory_breakdown TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_stats_storage_created ON stats_storage_snapshots(created_at);

-- Library statistics snapshots (daily)
CREATE TABLE IF NOT EXISTS stats_library_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    total_video_count INTEGER NOT NULL,
    available_video_count INTEGER NOT NULL,
    unavailable_video_count INTEGER NOT NULL,
    total_size_bytes INTEGER NOT NULL,
    average_size_bytes INTEGER NOT NULL,
    total_duration_seconds REAL NOT NULL,
    average_duration_seconds REAL NOT NULL,
    resolution_breakdown TEXT,
    codec_breakdown TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_stats_library_created ON stats_library_snapshots(created_at);

-- Content organization statistics snapshots (daily)
CREATE TABLE IF NOT EXISTS stats_content_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    videos_without_tags INTEGER NOT NULL,
    videos_without_creators INTEGER NOT NULL,
    videos_without_ratings INTEGER NOT NULL,
    videos_without_thumbnails INTEGER NOT NULL,
    videos_without_storyboards INTEGER NOT NULL,
    total_tags INTEGER NOT NULL,
    total_creators INTEGER NOT NULL,
    total_studios INTEGER NOT NULL,
    total_playlists INTEGER NOT NULL,
    top_tags TEXT,
    top_creators TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_stats_content_created ON stats_content_snapshots(created_at);

-- Usage/watch statistics snapshots (daily)
CREATE TABLE IF NOT EXISTS stats_usage_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    total_watch_time_seconds REAL NOT NULL,
    total_play_count INTEGER NOT NULL,
    unique_videos_watched INTEGER NOT NULL,
    videos_never_watched INTEGER NOT NULL,
    average_completion_rate REAL,
    top_watched TEXT,
    activity_by_hour TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_stats_usage_created ON stats_usage_snapshots(created_at);
