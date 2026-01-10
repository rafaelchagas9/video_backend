-- Migration: 003_enhanced_creators_studios
-- Created: 2026-01-09
-- Description: Enhanced creator management with studios, platform profiles, and social links

-- Add profile picture support to creators
ALTER TABLE creators ADD COLUMN profile_picture_path TEXT;

-- Studios table (organizations, networks, production companies)
CREATE TABLE IF NOT EXISTS studios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    profile_picture_path TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Platforms reference table (Patreon, OnlyFans, etc.)
CREATE TABLE IF NOT EXISTS platforms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    base_url TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Seed common platforms
INSERT OR IGNORE INTO platforms (name, base_url) VALUES
    ('Patreon', 'https://patreon.com'),
    ('OnlyFans', 'https://onlyfans.com'),
    ('Fansly', 'https://fansly.com'),
    ('ManyVids', 'https://manyvids.com');

-- Creator platform profiles (for fingerprinting and auto-scraping)
CREATE TABLE IF NOT EXISTS creator_platforms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    creator_id INTEGER NOT NULL,
    platform_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    profile_url TEXT NOT NULL,
    is_primary BOOLEAN DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (creator_id) REFERENCES creators(id) ON DELETE CASCADE,
    FOREIGN KEY (platform_id) REFERENCES platforms(id) ON DELETE CASCADE,
    UNIQUE(creator_id, platform_id)
);

CREATE INDEX IF NOT EXISTS idx_creator_platforms_creator ON creator_platforms(creator_id);
CREATE INDEX IF NOT EXISTS idx_creator_platforms_platform ON creator_platforms(platform_id);
CREATE INDEX IF NOT EXISTS idx_creator_platforms_username ON creator_platforms(username);

-- Creator-Studio relationship (many-to-many)
CREATE TABLE IF NOT EXISTS creator_studios (
    creator_id INTEGER NOT NULL,
    studio_id INTEGER NOT NULL,
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (creator_id, studio_id),
    FOREIGN KEY (creator_id) REFERENCES creators(id) ON DELETE CASCADE,
    FOREIGN KEY (studio_id) REFERENCES studios(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_creator_studios_creator ON creator_studios(creator_id);
CREATE INDEX IF NOT EXISTS idx_creator_studios_studio ON creator_studios(studio_id);

-- Video-Studio relationship (many-to-many)
CREATE TABLE IF NOT EXISTS video_studios (
    video_id INTEGER NOT NULL,
    studio_id INTEGER NOT NULL,
    PRIMARY KEY (video_id, studio_id),
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
    FOREIGN KEY (studio_id) REFERENCES studios(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_video_studios_video ON video_studios(video_id);
CREATE INDEX IF NOT EXISTS idx_video_studios_studio ON video_studios(studio_id);

-- Creator social media links
CREATE TABLE IF NOT EXISTS creator_social_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    creator_id INTEGER NOT NULL,
    platform_name TEXT NOT NULL,
    url TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (creator_id) REFERENCES creators(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_creator_social_links_creator ON creator_social_links(creator_id);

-- Studio social media links
CREATE TABLE IF NOT EXISTS studio_social_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    studio_id INTEGER NOT NULL,
    platform_name TEXT NOT NULL,
    url TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (studio_id) REFERENCES studios(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_studio_social_links_studio ON studio_social_links(studio_id);
