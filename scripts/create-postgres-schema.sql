-- PostgreSQL Schema Migration
-- Converted from SQLite schema for video streaming application
-- Total tables: 36 (33 existing + 3 new tagging rules tables)

-- ==================================================================
-- CORE SYSTEM TABLES
-- ==================================================================

-- Users table (single user, but structured for potential expansion)
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Sessions table (session-based authentication)
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- App settings (key-value configuration)
CREATE TABLE app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Watched directories
CREATE TABLE watched_directories (
    id SERIAL PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    is_active BOOLEAN DEFAULT true,
    auto_scan BOOLEAN DEFAULT true,
    scan_interval_minutes INTEGER DEFAULT 30,
    last_scan_at TIMESTAMP,
    added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ==================================================================
-- MEDIA MANAGEMENT TABLES
-- ==================================================================

-- Videos table (core media information)
CREATE TABLE videos (
    id SERIAL PRIMARY KEY,
    file_path TEXT NOT NULL UNIQUE,
    file_name TEXT NOT NULL,
    directory_id INTEGER NOT NULL,

    -- File metadata
    file_size_bytes BIGINT NOT NULL,
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
    is_available BOOLEAN DEFAULT true,
    is_deleted BOOLEAN DEFAULT false,
    last_verified_at TIMESTAMP,
    indexed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (directory_id) REFERENCES watched_directories(id) ON DELETE CASCADE
);

CREATE INDEX idx_videos_directory ON videos(directory_id);
CREATE INDEX idx_videos_file_path ON videos(file_path);
CREATE INDEX idx_videos_file_hash ON videos(file_hash);
CREATE INDEX idx_videos_title ON videos(title);
CREATE INDEX idx_videos_indexed_at ON videos(indexed_at);
CREATE INDEX idx_videos_created_at ON videos(created_at);
CREATE INDEX idx_videos_duration ON videos(duration_seconds);
CREATE INDEX idx_videos_resolution ON videos(width, height);
CREATE INDEX idx_videos_codec ON videos(codec);
CREATE INDEX idx_videos_available ON videos(is_available) WHERE is_available = true;
CREATE INDEX idx_videos_deleted ON videos(is_deleted) WHERE is_deleted = true;

-- Video statistics (per-user watch data)
CREATE TABLE video_stats (
    user_id INTEGER NOT NULL,
    video_id INTEGER NOT NULL,
    play_count INTEGER DEFAULT 0,
    total_watch_seconds REAL DEFAULT 0,
    session_watch_seconds REAL DEFAULT 0,
    session_play_counted BOOLEAN DEFAULT false,
    last_position_seconds REAL,
    last_played_at TIMESTAMP,
    last_watch_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (user_id, video_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);

CREATE INDEX idx_video_stats_video ON video_stats(video_id);
CREATE INDEX idx_video_stats_user ON video_stats(user_id);
CREATE INDEX idx_video_stats_last_played ON video_stats(last_played_at);

-- Scan history/logs
CREATE TABLE scan_logs (
    id SERIAL PRIMARY KEY,
    directory_id INTEGER NOT NULL,
    files_found INTEGER DEFAULT 0,
    files_added INTEGER DEFAULT 0,
    files_updated INTEGER DEFAULT 0,
    files_removed INTEGER DEFAULT 0,
    errors TEXT,
    started_at TIMESTAMP NOT NULL,
    completed_at TIMESTAMP,

    FOREIGN KEY (directory_id) REFERENCES watched_directories(id) ON DELETE CASCADE
);

CREATE INDEX idx_scan_logs_directory ON scan_logs(directory_id);
CREATE INDEX idx_scan_logs_started ON scan_logs(started_at);

-- ==================================================================
-- CONTENT ORGANIZATION TABLES
-- ==================================================================

-- Creators table
CREATE TABLE creators (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    profile_picture_path TEXT,
    is_verified BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Studios table (organizations, networks, production companies)
CREATE TABLE studios (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    profile_picture_path TEXT,
    is_verified BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Platforms reference table (Patreon, OnlyFans, etc.)
CREATE TABLE platforms (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    base_url TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Hierarchical tags (self-referencing for parent/child)
CREATE TABLE tags (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    parent_id INTEGER,
    description TEXT,
    color TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (parent_id) REFERENCES tags(id) ON DELETE CASCADE,
    UNIQUE(name, parent_id)
);

CREATE INDEX idx_tags_parent ON tags(parent_id);

-- Video-Creator relationship (many-to-many)
CREATE TABLE video_creators (
    video_id INTEGER NOT NULL,
    creator_id INTEGER NOT NULL,
    PRIMARY KEY (video_id, creator_id),
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
    FOREIGN KEY (creator_id) REFERENCES creators(id) ON DELETE CASCADE
);

CREATE INDEX idx_video_creators_video ON video_creators(video_id);
CREATE INDEX idx_video_creators_creator ON video_creators(creator_id);

-- Video-Studio relationship (many-to-many)
CREATE TABLE video_studios (
    video_id INTEGER NOT NULL,
    studio_id INTEGER NOT NULL,
    PRIMARY KEY (video_id, studio_id),
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
    FOREIGN KEY (studio_id) REFERENCES studios(id) ON DELETE CASCADE
);

CREATE INDEX idx_video_studios_video ON video_studios(video_id);
CREATE INDEX idx_video_studios_studio ON video_studios(studio_id);

-- Video-Tag relationship (many-to-many)
CREATE TABLE video_tags (
    video_id INTEGER NOT NULL,
    tag_id INTEGER NOT NULL,
    PRIMARY KEY (video_id, tag_id),
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
    FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);

CREATE INDEX idx_video_tags_video ON video_tags(video_id);
CREATE INDEX idx_video_tags_tag ON video_tags(tag_id);

-- Creator platform profiles (for fingerprinting and auto-scraping)
CREATE TABLE creator_platforms (
    id SERIAL PRIMARY KEY,
    creator_id INTEGER NOT NULL,
    platform_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    profile_url TEXT NOT NULL,
    is_primary BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (creator_id) REFERENCES creators(id) ON DELETE CASCADE,
    FOREIGN KEY (platform_id) REFERENCES platforms(id) ON DELETE CASCADE,
    UNIQUE(creator_id, platform_id)
);

CREATE INDEX idx_creator_platforms_creator ON creator_platforms(creator_id);
CREATE INDEX idx_creator_platforms_platform ON creator_platforms(platform_id);
CREATE INDEX idx_creator_platforms_username ON creator_platforms(username);

-- Creator-Studio relationship (many-to-many)
CREATE TABLE creator_studios (
    creator_id INTEGER NOT NULL,
    studio_id INTEGER NOT NULL,
    added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (creator_id, studio_id),
    FOREIGN KEY (creator_id) REFERENCES creators(id) ON DELETE CASCADE,
    FOREIGN KEY (studio_id) REFERENCES studios(id) ON DELETE CASCADE
);

CREATE INDEX idx_creator_studios_creator ON creator_studios(creator_id);
CREATE INDEX idx_creator_studios_studio ON creator_studios(studio_id);

-- Creator social media links
CREATE TABLE creator_social_links (
    id SERIAL PRIMARY KEY,
    creator_id INTEGER NOT NULL,
    platform_name TEXT NOT NULL,
    url TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (creator_id) REFERENCES creators(id) ON DELETE CASCADE
);

CREATE INDEX idx_creator_social_links_creator ON creator_social_links(creator_id);

-- Studio social media links
CREATE TABLE studio_social_links (
    id SERIAL PRIMARY KEY,
    studio_id INTEGER NOT NULL,
    platform_name TEXT NOT NULL,
    url TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (studio_id) REFERENCES studios(id) ON DELETE CASCADE
);

CREATE INDEX idx_studio_social_links_studio ON studio_social_links(studio_id);

-- ==================================================================
-- USER FEATURES TABLES
-- ==================================================================

-- Playlists
CREATE TABLE playlists (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE playlist_videos (
    playlist_id INTEGER NOT NULL,
    video_id INTEGER NOT NULL,
    position INTEGER NOT NULL,
    added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (playlist_id, video_id),
    FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);

CREATE INDEX idx_playlist_videos_playlist ON playlist_videos(playlist_id, position);

-- Favorites
CREATE TABLE favorites (
    user_id INTEGER NOT NULL,
    video_id INTEGER NOT NULL,
    added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (user_id, video_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);

CREATE INDEX idx_favorites_user ON favorites(user_id);

-- Bookmarks
CREATE TABLE bookmarks (
    id SERIAL PRIMARY KEY,
    video_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    timestamp_seconds REAL NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_bookmarks_video ON bookmarks(video_id, timestamp_seconds);
CREATE INDEX idx_bookmarks_user ON bookmarks(user_id);

-- Ratings table
CREATE TABLE ratings (
    id SERIAL PRIMARY KEY,
    video_id INTEGER NOT NULL,
    rating INTEGER NOT NULL CHECK(rating >= 1 AND rating <= 5),
    comment TEXT,
    rated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);

CREATE INDEX idx_ratings_video ON ratings(video_id);

-- Custom metadata (arbitrary key-value pairs)
CREATE TABLE video_metadata (
    id SERIAL PRIMARY KEY,
    video_id INTEGER NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
    UNIQUE(video_id, key)
);

CREATE INDEX idx_video_metadata_video ON video_metadata(video_id);
CREATE INDEX idx_video_metadata_key ON video_metadata(key);

-- ==================================================================
-- MEDIA PROCESSING TABLES
-- ==================================================================

-- Conversion Jobs
CREATE TABLE conversion_jobs (
    id SERIAL PRIMARY KEY,
    video_id INTEGER NOT NULL,
    status TEXT NOT NULL, -- pending, processing, completed, failed, cancelled
    preset TEXT NOT NULL,
    target_resolution TEXT,
    codec TEXT NOT NULL,
    output_path TEXT,
    output_size_bytes BIGINT,
    progress_percent INTEGER DEFAULT 0,
    error_message TEXT,

    -- Configuration
    delete_original BOOLEAN DEFAULT false,
    is_deleted BOOLEAN DEFAULT false,
    batch_id TEXT,

    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);

CREATE INDEX idx_conversion_jobs_video ON conversion_jobs(video_id);
CREATE INDEX idx_conversion_jobs_status ON conversion_jobs(status);
CREATE INDEX idx_conversion_jobs_batch ON conversion_jobs(batch_id);

-- Thumbnails tracking
CREATE TABLE thumbnails (
    id SERIAL PRIMARY KEY,
    video_id INTEGER NOT NULL UNIQUE,
    file_path TEXT NOT NULL,
    file_size_bytes BIGINT,
    timestamp_seconds REAL DEFAULT 5.0,
    width INTEGER,
    height INTEGER,
    auto_generated BOOLEAN DEFAULT false,
    generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);

CREATE INDEX idx_thumbnails_video ON thumbnails(video_id);

-- Storyboards (video preview sprites)
CREATE TABLE storyboards (
    id SERIAL PRIMARY KEY,
    video_id INTEGER NOT NULL UNIQUE,
    sprite_path TEXT NOT NULL,
    vtt_path TEXT NOT NULL,
    tile_width INTEGER NOT NULL,
    tile_height INTEGER NOT NULL,
    tile_count INTEGER NOT NULL,
    interval_seconds REAL NOT NULL,
    sprite_size_bytes BIGINT,
    generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);

CREATE INDEX idx_storyboards_video ON storyboards(video_id);

-- ==================================================================
-- STATISTICS TABLES
-- ==================================================================

-- Storage statistics snapshots (hourly)
CREATE TABLE stats_storage_snapshots (
    id SERIAL PRIMARY KEY,
    total_video_size_bytes BIGINT NOT NULL,
    total_video_count INTEGER NOT NULL,
    thumbnails_size_bytes BIGINT NOT NULL DEFAULT 0,
    storyboards_size_bytes BIGINT NOT NULL DEFAULT 0,
    profile_pictures_size_bytes BIGINT NOT NULL DEFAULT 0,
    converted_size_bytes BIGINT NOT NULL DEFAULT 0,
    database_size_bytes BIGINT NOT NULL DEFAULT 0,
    directory_breakdown TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_stats_storage_created ON stats_storage_snapshots(created_at);

-- Library statistics snapshots (daily)
CREATE TABLE stats_library_snapshots (
    id SERIAL PRIMARY KEY,
    total_video_count INTEGER NOT NULL,
    available_video_count INTEGER NOT NULL,
    unavailable_video_count INTEGER NOT NULL,
    total_size_bytes BIGINT NOT NULL,
    average_size_bytes BIGINT NOT NULL,
    total_duration_seconds REAL NOT NULL,
    average_duration_seconds REAL NOT NULL,
    resolution_breakdown TEXT,
    codec_breakdown TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_stats_library_created ON stats_library_snapshots(created_at);

-- Content organization statistics snapshots (daily)
CREATE TABLE stats_content_snapshots (
    id SERIAL PRIMARY KEY,
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
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_stats_content_created ON stats_content_snapshots(created_at);

-- Usage/watch statistics snapshots (daily)
CREATE TABLE stats_usage_snapshots (
    id SERIAL PRIMARY KEY,
    total_watch_time_seconds REAL NOT NULL,
    total_play_count INTEGER NOT NULL,
    unique_videos_watched INTEGER NOT NULL,
    videos_never_watched INTEGER NOT NULL,
    average_completion_rate REAL,
    top_watched TEXT,
    activity_by_hour TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_stats_usage_created ON stats_usage_snapshots(created_at);

-- ==================================================================
-- TRIAGE SYSTEM TABLE
-- ==================================================================

-- Triage Progress Tracking
CREATE TABLE triage_progress (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    filter_key TEXT NOT NULL,
    last_video_id INTEGER,
    processed_count INTEGER DEFAULT 0,
    total_count INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (last_video_id) REFERENCES videos(id) ON DELETE SET NULL,
    UNIQUE(user_id, filter_key)
);

CREATE INDEX idx_triage_progress_user ON triage_progress(user_id);
CREATE INDEX idx_triage_progress_filter ON triage_progress(user_id, filter_key);

-- ==================================================================
-- TAGGING RULES SYSTEM (Auto-tagging engine)
-- ==================================================================

-- Tagging rules table
CREATE TABLE tagging_rules (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    rule_type TEXT NOT NULL DEFAULT 'path_match',
    is_enabled BOOLEAN DEFAULT true,
    priority INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_tagging_rules_enabled ON tagging_rules(is_enabled);
CREATE INDEX idx_tagging_rules_priority ON tagging_rules(priority);

-- Rule conditions (what to match)
CREATE TABLE tagging_rule_conditions (
    id SERIAL PRIMARY KEY,
    rule_id INTEGER NOT NULL,
    condition_type TEXT NOT NULL,
    operator TEXT NOT NULL,
    value TEXT NOT NULL,
    FOREIGN KEY (rule_id) REFERENCES tagging_rules(id) ON DELETE CASCADE
);

CREATE INDEX idx_tagging_rule_conditions_rule ON tagging_rule_conditions(rule_id);

-- Rule actions (what to do when matched)
CREATE TABLE tagging_rule_actions (
    id SERIAL PRIMARY KEY,
    rule_id INTEGER NOT NULL,
    action_type TEXT NOT NULL,
    target_id INTEGER,
    target_name TEXT,
    dynamic_value TEXT,
    FOREIGN KEY (rule_id) REFERENCES tagging_rules(id) ON DELETE CASCADE
);

CREATE INDEX idx_tagging_rule_actions_rule ON tagging_rule_actions(rule_id);

-- Tagging rule execution log
CREATE TABLE tagging_rule_log (
    id SERIAL PRIMARY KEY,
    rule_id INTEGER NOT NULL,
    video_id INTEGER NOT NULL,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    success BOOLEAN DEFAULT true,
    error_message TEXT,
    FOREIGN KEY (rule_id) REFERENCES tagging_rules(id) ON DELETE CASCADE,
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);

CREATE INDEX idx_tagging_rule_log_video ON tagging_rule_log(video_id);
CREATE INDEX idx_tagging_rule_log_rule ON tagging_rule_log(rule_id);
CREATE INDEX idx_tagging_rule_log_applied ON tagging_rule_log(applied_at);

-- ==================================================================
-- FACE RECOGNITION TABLES (NEW - requires pgvector extension)
-- ==================================================================

-- Creator face embeddings (known faces for matching)
CREATE TABLE creator_face_embeddings (
    id SERIAL PRIMARY KEY,
    creator_id INTEGER NOT NULL,
    embedding vector(512) NOT NULL,
    source_image_path TEXT,
    source_video_id INTEGER,
    confidence REAL,
    is_verified BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (creator_id) REFERENCES creators(id) ON DELETE CASCADE,
    FOREIGN KEY (source_video_id) REFERENCES videos(id) ON DELETE SET NULL
);

CREATE INDEX idx_creator_face_embeddings_creator ON creator_face_embeddings(creator_id);
-- HNSW index for vector similarity search (cosine distance)
CREATE INDEX idx_creator_face_embeddings_vector
    ON creator_face_embeddings
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

-- Video face detections (detected faces in videos)
CREATE TABLE video_face_detections (
    id SERIAL PRIMARY KEY,
    video_id INTEGER NOT NULL,
    embedding vector(512) NOT NULL,
    timestamp_seconds REAL NOT NULL,
    bounding_box_x INTEGER,
    bounding_box_y INTEGER,
    bounding_box_width INTEGER,
    bounding_box_height INTEGER,
    confidence REAL,
    matched_creator_id INTEGER,
    match_confidence REAL,
    is_verified BOOLEAN DEFAULT false,
    detected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
    FOREIGN KEY (matched_creator_id) REFERENCES creators(id) ON DELETE SET NULL
);

CREATE INDEX idx_video_face_detections_video ON video_face_detections(video_id);
CREATE INDEX idx_video_face_detections_creator ON video_face_detections(matched_creator_id);
CREATE INDEX idx_video_face_detections_timestamp ON video_face_detections(video_id, timestamp_seconds);
-- HNSW index for vector similarity search (cosine distance)
CREATE INDEX idx_video_face_detections_vector
    ON video_face_detections
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

-- Face recognition configuration
CREATE TABLE face_recognition_config (
    id SERIAL PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    value TEXT NOT NULL,
    description TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Face matching job queue (optional, for background processing)
CREATE TABLE face_match_queue (
    id SERIAL PRIMARY KEY,
    video_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- pending, processing, completed, failed
    priority INTEGER DEFAULT 0,
    frames_to_process INTEGER,
    frames_processed INTEGER DEFAULT 0,
    faces_detected INTEGER DEFAULT 0,
    faces_matched INTEGER DEFAULT 0,
    error_message TEXT,
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);

CREATE INDEX idx_face_match_queue_video ON face_match_queue(video_id);
CREATE INDEX idx_face_match_queue_status ON face_match_queue(status);
CREATE INDEX idx_face_match_queue_priority ON face_match_queue(priority, created_at);
