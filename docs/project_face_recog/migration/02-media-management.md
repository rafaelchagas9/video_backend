# Media Management Tables

Core tables for video files and directory scanning.

## 1. videos

Main table storing all video file metadata.

### SQLite Schema
```sql
CREATE TABLE videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path TEXT NOT NULL UNIQUE,
    file_name TEXT NOT NULL,
    directory_id INTEGER NOT NULL,

    -- File metadata
    file_size_bytes INTEGER NOT NULL,
    file_hash TEXT,

    -- Video metadata (extracted via FFprobe)
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

-- Indexes (17 total!)
CREATE INDEX idx_videos_directory ON videos(directory_id);
CREATE INDEX idx_videos_file_path ON videos(file_path);
CREATE INDEX idx_videos_file_hash ON videos(file_hash);
CREATE INDEX idx_videos_availability ON videos(is_available);
CREATE INDEX idx_videos_is_available ON videos(is_available);
CREATE INDEX idx_videos_directory_available ON videos(directory_id, is_available);
CREATE INDEX idx_videos_file_name ON videos(file_name);
CREATE INDEX idx_videos_filesize ON videos(file_size_bytes);
CREATE INDEX idx_videos_duration ON videos(duration_seconds);
CREATE INDEX idx_videos_codec ON videos(codec);
CREATE INDEX idx_videos_audio_codec ON videos(audio_codec);
CREATE INDEX idx_videos_bitrate ON videos(bitrate);
CREATE INDEX idx_videos_fps ON videos(fps);
```

### PostgreSQL Schema
```sql
CREATE TABLE videos (
    id SERIAL PRIMARY KEY,
    file_path TEXT NOT NULL UNIQUE,
    file_name TEXT NOT NULL,
    directory_id INTEGER NOT NULL,

    -- File metadata
    file_size_bytes BIGINT NOT NULL, -- Changed from INTEGER for large files
    file_hash TEXT,

    -- Video metadata (extracted via FFprobe)
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
    last_verified_at TIMESTAMP,
    indexed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (directory_id) REFERENCES watched_directories(id) ON DELETE CASCADE
);

-- Indexes (consolidated duplicates)
CREATE INDEX idx_videos_directory ON videos(directory_id);
CREATE INDEX idx_videos_file_path ON videos(file_path);
CREATE INDEX idx_videos_file_hash ON videos(file_hash);
CREATE INDEX idx_videos_is_available ON videos(is_available);
CREATE INDEX idx_videos_directory_available ON videos(directory_id, is_available);
CREATE INDEX idx_videos_file_name ON videos(file_name);
CREATE INDEX idx_videos_filesize ON videos(file_size_bytes);
CREATE INDEX idx_videos_duration ON videos(duration_seconds);
CREATE INDEX idx_videos_codec ON videos(codec);
CREATE INDEX idx_videos_audio_codec ON videos(audio_codec);
CREATE INDEX idx_videos_bitrate ON videos(bitrate);
CREATE INDEX idx_videos_fps ON videos(fps);
```

**Current Data**: 2,091 videos

**Migration Notes**:
- `file_size_bytes`: Changed to `BIGINT` for files > 2GB
- `is_available`: Boolean conversion (1/0 → true/false)
- `file_hash`: XXH3-128 hash for collision detection
- Removed duplicate index: `idx_videos_availability` (duplicate of `idx_videos_is_available`)
- File paths are absolute paths on server filesystem

**Key Fields**:
- **file_hash**: Computed via `@node-rs/xxhash` (XXH3-128 partial for files >= 10MB, XXH3-64 full for smaller)
- **themes**: Comma-separated text field (consider normalizing to separate table in future)
- **is_available**: Soft delete flag - set to false when file missing during scan

---

## 2. scan_logs

History of directory scan operations.

### SQLite Schema
```sql
CREATE TABLE scan_logs (
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

CREATE INDEX idx_scan_logs_directory ON scan_logs(directory_id);
CREATE INDEX idx_scan_logs_started ON scan_logs(started_at);
CREATE INDEX idx_scan_logs_completed_at ON scan_logs(completed_at);
```

### PostgreSQL Schema
```sql
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
CREATE INDEX idx_scan_logs_completed_at ON scan_logs(completed_at);
```

**Current Data**: 123 scan logs

**Migration Notes**:
- Direct schema transfer
- `errors` field stores JSON or plain text error messages
- `completed_at` is NULL for in-progress scans (unlikely during migration)

---

## Migration Considerations

### File Path Validation

After migration, verify all file paths are accessible:

```sql
-- Videos with missing files (should match is_available = false)
SELECT id, file_path, is_available
FROM videos
WHERE is_available = false;

-- Check for absolute vs relative paths
SELECT file_path
FROM videos
WHERE file_path NOT LIKE '/%'  -- Unix absolute paths
LIMIT 10;
```

### Hash Collision Detection

The system uses XXH3 hashing with collision detection:

```sql
-- Check for hash collisions (should be rare)
SELECT file_hash, COUNT(*) as count
FROM videos
WHERE file_hash IS NOT NULL
GROUP BY file_hash
HAVING COUNT(*) > 1;
```

### Storage Statistics

```sql
-- Total storage by availability
SELECT
    is_available,
    COUNT(*) as video_count,
    SUM(file_size_bytes) as total_bytes,
    SUM(file_size_bytes) / 1024 / 1024 / 1024 as total_gb,
    AVG(file_size_bytes) / 1024 / 1024 as avg_mb
FROM videos
GROUP BY is_available;

-- Top 10 largest videos
SELECT id, file_name, file_size_bytes / 1024 / 1024 / 1024 as size_gb
FROM videos
ORDER BY file_size_bytes DESC
LIMIT 10;
```

### Scan Performance

```sql
-- Average scan duration
SELECT
    AVG(EXTRACT(EPOCH FROM (completed_at - started_at))) as avg_seconds,
    AVG(files_found) as avg_files_found,
    AVG(files_added) as avg_files_added
FROM scan_logs
WHERE completed_at IS NOT NULL;

-- Failed scans
SELECT id, started_at, errors
FROM scan_logs
WHERE errors IS NOT NULL
ORDER BY started_at DESC
LIMIT 10;
```

## Data Integrity Checks

```sql
-- Videos referencing non-existent directories
SELECT v.id, v.file_path, v.directory_id
FROM videos v
LEFT JOIN watched_directories wd ON wd.id = v.directory_id
WHERE wd.id IS NULL;

-- Scan logs for deleted directories
SELECT sl.id, sl.directory_id, sl.started_at
FROM scan_logs sl
LEFT JOIN watched_directories wd ON wd.id = sl.directory_id
WHERE wd.id IS NULL;
```
