# Statistics Tables

Time-series snapshot tables for storage, library, content, and usage analytics.

## Overview

Four snapshot tables capture metrics at different intervals:

| Table | Frequency | Purpose |
|-------|-----------|---------|
| stats_storage_snapshots | Hourly | Disk usage tracking |
| stats_library_snapshots | Daily | Video library metrics |
| stats_content_snapshots | Daily | Content organization completeness |
| stats_usage_snapshots | Daily | Watch statistics |

All tables store JSON in TEXT columns for flexible breakdown data.

---

## 1. stats_storage_snapshots

Hourly storage usage snapshots.

### SQLite Schema
```sql
CREATE TABLE stats_storage_snapshots (
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

CREATE INDEX idx_stats_storage_created ON stats_storage_snapshots(created_at);
```

### PostgreSQL Schema
```sql
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
```

**Current Data**: 41 snapshots

**Migration Notes**:
- All byte fields changed to BIGINT for multi-TB storage
- `directory_breakdown`: JSON string with per-directory stats
- Consider using JSONB type in PostgreSQL for directory_breakdown

**PostgreSQL Enhancement**:
```sql
ALTER TABLE stats_storage_snapshots
    ALTER COLUMN directory_breakdown TYPE JSONB USING directory_breakdown::jsonb;

CREATE INDEX idx_stats_storage_breakdown_gin
    ON stats_storage_snapshots USING gin(directory_breakdown);
```

---

## 2. stats_library_snapshots

Daily video library metrics.

### SQLite Schema
```sql
CREATE TABLE stats_library_snapshots (
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

CREATE INDEX idx_stats_library_created ON stats_library_snapshots(created_at);
```

### PostgreSQL Schema
```sql
CREATE TABLE stats_library_snapshots (
    id SERIAL PRIMARY KEY,
    total_video_count INTEGER NOT NULL,
    available_video_count INTEGER NOT NULL,
    unavailable_video_count INTEGER NOT NULL,
    total_size_bytes BIGINT NOT NULL,
    average_size_bytes BIGINT NOT NULL,
    total_duration_seconds REAL NOT NULL,
    average_duration_seconds REAL NOT NULL,
    resolution_breakdown JSONB,
    codec_breakdown JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_stats_library_created ON stats_library_snapshots(created_at);
CREATE INDEX idx_stats_library_resolution_gin ON stats_library_snapshots USING gin(resolution_breakdown);
CREATE INDEX idx_stats_library_codec_gin ON stats_library_snapshots USING gin(codec_breakdown);
```

**Current Data**: 5 snapshots

**Migration Notes**:
- Byte fields → BIGINT
- Breakdown fields: TEXT → JSONB for better querying
- `resolution_breakdown`: e.g., `{"1920x1080": 450, "1280x720": 320}`
- `codec_breakdown`: e.g., `{"h264": 1200, "hevc": 650, "av1": 50}`

---

## 3. stats_content_snapshots

Daily content organization metrics.

### SQLite Schema
```sql
CREATE TABLE stats_content_snapshots (
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

CREATE INDEX idx_stats_content_created ON stats_content_snapshots(created_at);
```

### PostgreSQL Schema
```sql
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
    top_tags JSONB,
    top_creators JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_stats_content_created ON stats_content_snapshots(created_at);
CREATE INDEX idx_stats_content_top_tags_gin ON stats_content_snapshots USING gin(top_tags);
CREATE INDEX idx_stats_content_top_creators_gin ON stats_content_snapshots USING gin(top_creators);
```

**Current Data**: 5 snapshots

**Migration Notes**:
- Tracks organization completeness
- `top_tags`: JSON array of most-used tags with counts
- `top_creators`: JSON array of creators with video counts
- Useful for identifying content needing organization

**Example JSON**:
```json
{
  "top_tags": [
    {"name": "BDSM", "count": 145},
    {"name": "Bondage", "count": 89}
  ],
  "top_creators": [
    {"name": "Jane Doe", "count": 67},
    {"name": "John Smith", "count": 45}
  ]
}
```

---

## 4. stats_usage_snapshots

Daily watch statistics.

### SQLite Schema
```sql
CREATE TABLE stats_usage_snapshots (
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

CREATE INDEX idx_stats_usage_created ON stats_usage_snapshots(created_at);
```

### PostgreSQL Schema
```sql
CREATE TABLE stats_usage_snapshots (
    id SERIAL PRIMARY KEY,
    total_watch_time_seconds REAL NOT NULL,
    total_play_count INTEGER NOT NULL,
    unique_videos_watched INTEGER NOT NULL,
    videos_never_watched INTEGER NOT NULL,
    average_completion_rate REAL,
    top_watched JSONB,
    activity_by_hour JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_stats_usage_created ON stats_usage_snapshots(created_at);
CREATE INDEX idx_stats_usage_top_watched_gin ON stats_usage_snapshots USING gin(top_watched);
CREATE INDEX idx_stats_usage_activity_gin ON stats_usage_snapshots USING gin(activity_by_hour);
```

**Current Data**: 5 snapshots

**Migration Notes**:
- `top_watched`: JSON array of most-watched videos
- `activity_by_hour`: JSON object mapping hour (0-23) to play count
- `average_completion_rate`: Average percentage watched

**Example JSON**:
```json
{
  "top_watched": [
    {"video_id": 1234, "title": "Video Name", "play_count": 15},
    {"video_id": 5678, "title": "Another Video", "play_count": 12}
  ],
  "activity_by_hour": {
    "0": 5,
    "1": 2,
    "20": 45,
    "21": 67,
    "22": 89
  }
}
```

---

## Migration Strategy

### 1. Schema Migration

All tables follow the same pattern:
- `INTEGER` → `SERIAL` for primary keys
- `INTEGER` → `BIGINT` for byte counts
- `DATETIME` → `TIMESTAMP`
- `TEXT` → `JSONB` for breakdown columns (recommended)

### 2. Data Transformation

```typescript
// Example: Transform stats_storage_snapshots
const storageSnapshots = db.query("SELECT * FROM stats_storage_snapshots").all();

for (const snapshot of storageSnapshots) {
    // Parse JSON strings
    const directoryBreakdown = snapshot.directory_breakdown
        ? JSON.parse(snapshot.directory_breakdown)
        : null;

    await pgPool.query(
        `INSERT INTO stats_storage_snapshots (
            id, total_video_size_bytes, total_video_count,
            thumbnails_size_bytes, storyboards_size_bytes,
            profile_pictures_size_bytes, converted_size_bytes,
            database_size_bytes, directory_breakdown, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
            snapshot.id,
            snapshot.total_video_size_bytes,
            snapshot.total_video_count,
            snapshot.thumbnails_size_bytes,
            snapshot.storyboards_size_bytes,
            snapshot.profile_pictures_size_bytes,
            snapshot.converted_size_bytes,
            snapshot.database_size_bytes,
            JSON.stringify(directoryBreakdown),
            snapshot.created_at
        ]
    );
}
```

### 3. Retention Policy

Consider implementing retention policies:

```sql
-- Keep hourly storage snapshots for 7 days, then daily aggregates
DELETE FROM stats_storage_snapshots
WHERE created_at < NOW() - INTERVAL '7 days'
  AND EXTRACT(HOUR FROM created_at) != 0;

-- Keep daily snapshots for 90 days
DELETE FROM stats_library_snapshots
WHERE created_at < NOW() - INTERVAL '90 days';
```

---

## Verification Queries

```sql
-- Verify snapshot counts
SELECT
    'storage' as type,
    COUNT(*) as snapshot_count,
    MIN(created_at) as earliest,
    MAX(created_at) as latest
FROM stats_storage_snapshots
UNION ALL
SELECT 'library', COUNT(*), MIN(created_at), MAX(created_at)
FROM stats_library_snapshots
UNION ALL
SELECT 'content', COUNT(*), MIN(created_at), MAX(created_at)
FROM stats_content_snapshots
UNION ALL
SELECT 'usage', COUNT(*), MIN(created_at), MAX(created_at)
FROM stats_usage_snapshots;

-- Storage growth over time
SELECT
    DATE(created_at) as date,
    total_video_size_bytes / 1024 / 1024 / 1024 as total_gb,
    total_video_count
FROM stats_storage_snapshots
ORDER BY created_at DESC
LIMIT 30;

-- Content organization trends
SELECT
    DATE(created_at) as date,
    videos_without_tags,
    videos_without_creators,
    videos_without_thumbnails
FROM stats_content_snapshots
ORDER BY created_at DESC
LIMIT 30;
```

## PostgreSQL Analytics Queries

```sql
-- Weekly storage growth rate
SELECT
    DATE_TRUNC('week', created_at) as week,
    AVG(total_video_size_bytes) / 1024 / 1024 / 1024 as avg_gb,
    MAX(total_video_size_bytes) - MIN(total_video_size_bytes) as growth_bytes
FROM stats_storage_snapshots
GROUP BY week
ORDER BY week DESC;

-- Most common resolutions (from JSONB)
SELECT
    key as resolution,
    AVG((value::text)::int) as avg_count
FROM stats_library_snapshots,
     jsonb_each(resolution_breakdown)
GROUP BY key
ORDER BY avg_count DESC;
```
