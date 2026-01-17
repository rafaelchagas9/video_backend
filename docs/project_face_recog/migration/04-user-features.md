# User Features Tables

Tables for playlists, favorites, bookmarks, ratings, watch statistics, and custom metadata.

## 1. playlists

User-created playlists.

### SQLite Schema
```sql
CREATE TABLE playlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
```

### PostgreSQL Schema
```sql
CREATE TABLE playlists (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
```

**Current Data**: 1 playlist

---

## 2. playlist_videos

Playlist contents with position ordering.

### SQLite Schema
```sql
CREATE TABLE playlist_videos (
    playlist_id INTEGER NOT NULL,
    video_id INTEGER NOT NULL,
    position INTEGER NOT NULL,
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (playlist_id, video_id),
    FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);

CREATE INDEX idx_playlist_videos_playlist ON playlist_videos(playlist_id, position);
CREATE INDEX idx_playlist_videos_video_id ON playlist_videos(video_id);
```

### PostgreSQL Schema
```sql
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
CREATE INDEX idx_playlist_videos_video_id ON playlist_videos(video_id);
```

**Current Data**: 18 videos in playlists

**Migration Notes**:
- `position` field determines order in playlist
- API auto-assigns position if not provided (MAX + 1)
- Composite index on (playlist_id, position) for efficient ordering queries

---

## 3. favorites

User-favorited videos.

### SQLite Schema
```sql
CREATE TABLE favorites (
    user_id INTEGER NOT NULL,
    video_id INTEGER NOT NULL,
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (user_id, video_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);

CREATE INDEX idx_favorites_user ON favorites(user_id);
CREATE INDEX idx_favorites_video_id ON favorites(video_id);
```

### PostgreSQL Schema
```sql
CREATE TABLE favorites (
    user_id INTEGER NOT NULL,
    video_id INTEGER NOT NULL,
    added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (user_id, video_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);

CREATE INDEX idx_favorites_user ON favorites(user_id);
CREATE INDEX idx_favorites_video_id ON favorites(video_id);
```

**Current Data**: 15 favorite videos

---

## 4. bookmarks

Timestamp bookmarks within videos.

### SQLite Schema
```sql
CREATE TABLE bookmarks (
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

CREATE INDEX idx_bookmarks_video ON bookmarks(video_id, timestamp_seconds);
CREATE INDEX idx_bookmarks_user ON bookmarks(user_id);
```

### PostgreSQL Schema
```sql
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
```

**Current Data**: 2 bookmarks

**Migration Notes**:
- `timestamp_seconds` is a REAL for precise seeking (e.g., 125.5)
- Composite index on (video_id, timestamp_seconds) for timeline queries

---

## 5. ratings

1-5 star ratings with optional comments.

### SQLite Schema
```sql
CREATE TABLE ratings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id INTEGER NOT NULL,
    rating INTEGER NOT NULL CHECK(rating >= 1 AND rating <= 5),
    comment TEXT,
    rated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);

CREATE INDEX idx_ratings_video ON ratings(video_id);
```

### PostgreSQL Schema
```sql
CREATE TABLE ratings (
    id SERIAL PRIMARY KEY,
    video_id INTEGER NOT NULL,
    rating INTEGER NOT NULL CHECK(rating >= 1 AND rating <= 5),
    comment TEXT,
    rated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);

CREATE INDEX idx_ratings_video ON ratings(video_id);
```

**Current Data**: 0 ratings (table empty)

**Migration Notes**:
- CHECK constraint ensures rating 1-5
- No user_id foreign key (single-user system)
- One rating per video (enforced at application level, not schema)

---

## 6. video_stats

Per-user watch statistics for each video.

### SQLite Schema
```sql
CREATE TABLE video_stats (
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

CREATE INDEX idx_video_stats_video ON video_stats(video_id);
CREATE INDEX idx_video_stats_user ON video_stats(user_id);
CREATE INDEX idx_video_stats_last_played ON video_stats(last_played_at);
```

### PostgreSQL Schema
```sql
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
```

**Current Data**: 290 watch history entries

**Migration Notes**:
- Boolean conversion: `session_play_counted` 0/1 → false/true
- `session_watch_seconds`: Tracks current viewing session
- `session_play_counted`: Prevents double-counting in same session
- Watch counting rules from app_settings:
  - `min_watch_seconds`: 60 (minimum to count as "played")
  - `short_video_watch_seconds`: 10
  - `watch_session_gap_minutes`: 30

---

## 7. video_metadata

Custom key-value metadata per video.

### SQLite Schema
```sql
CREATE TABLE video_metadata (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id INTEGER NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
    UNIQUE(video_id, key)
);

CREATE INDEX idx_video_metadata_video ON video_metadata(video_id);
CREATE INDEX idx_video_metadata_key ON video_metadata(key);
```

### PostgreSQL Schema
```sql
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
```

**Current Data**: 0 entries (table empty)

**Migration Notes**:
- Flexible schema for arbitrary metadata
- UNIQUE constraint prevents duplicate keys per video
- Index on `key` allows searching across videos by metadata type

---

## Migration Order

1. `playlists` (depends on users)
2. `playlist_videos` (depends on playlists + videos)
3. `favorites` (depends on users + videos)
4. `bookmarks` (depends on users + videos)
5. `ratings` (depends on videos)
6. `video_stats` (depends on users + videos)
7. `video_metadata` (depends on videos)

## Data Integrity Checks

```sql
-- Orphaned playlist videos
SELECT COUNT(*) FROM playlist_videos pv
LEFT JOIN playlists p ON p.id = pv.playlist_id
WHERE p.id IS NULL;

-- Favorites for non-existent videos
SELECT COUNT(*) FROM favorites f
LEFT JOIN videos v ON v.id = f.video_id
WHERE v.id IS NULL;

-- Watch stats summary
SELECT
    COUNT(DISTINCT video_id) as videos_watched,
    SUM(play_count) as total_plays,
    SUM(total_watch_seconds) / 3600 as total_hours,
    AVG(play_count) as avg_plays_per_video
FROM video_stats;

-- Videos never watched
SELECT COUNT(*) FROM videos v
LEFT JOIN video_stats vs ON vs.video_id = v.id
WHERE vs.video_id IS NULL AND v.is_available = true;

-- Playlist position gaps
SELECT playlist_id,
       position,
       position - LAG(position) OVER (PARTITION BY playlist_id ORDER BY position) as gap
FROM playlist_videos
WHERE position - LAG(position) OVER (PARTITION BY playlist_id ORDER BY position) > 1;
```

## PostgreSQL-Specific Enhancements

Consider these improvements after migration:

```sql
-- Add JSONB for video_metadata (more efficient than key-value rows)
ALTER TABLE videos ADD COLUMN metadata JSONB;
CREATE INDEX idx_videos_metadata_gin ON videos USING gin(metadata);

-- Add computed column for completion rate
ALTER TABLE video_stats ADD COLUMN completion_rate REAL
GENERATED ALWAYS AS (
    CASE
        WHEN total_watch_seconds > 0
        THEN LEAST(1.0, total_watch_seconds / NULLIF((SELECT duration_seconds FROM videos WHERE id = video_id), 0))
        ELSE 0
    END
) STORED;
```
