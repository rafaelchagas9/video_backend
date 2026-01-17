# Media Processing Tables

Tables for video conversions, thumbnails, and storyboard generation.

## 1. conversion_jobs

GPU-accelerated video conversion job queue.

### SQLite Schema
```sql
CREATE TABLE conversion_jobs (
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
    delete_original BOOLEAN DEFAULT 0,
    batch_id TEXT,
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);

CREATE INDEX idx_conversion_jobs_video ON conversion_jobs(video_id);
CREATE INDEX idx_conversion_jobs_status ON conversion_jobs(status);
CREATE INDEX idx_conversion_jobs_batch ON conversion_jobs(batch_id);
```

### PostgreSQL Schema
```sql
CREATE TABLE conversion_jobs (
    id SERIAL PRIMARY KEY,
    video_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    preset TEXT NOT NULL,
    target_resolution TEXT,
    codec TEXT NOT NULL,
    output_path TEXT,
    output_size_bytes BIGINT,
    progress_percent REAL DEFAULT 0,
    error_message TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    delete_original BOOLEAN DEFAULT false,
    batch_id TEXT,

    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
    CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'cancelled'))
);

CREATE INDEX idx_conversion_jobs_video ON conversion_jobs(video_id);
CREATE INDEX idx_conversion_jobs_status ON conversion_jobs(status);
CREATE INDEX idx_conversion_jobs_batch ON conversion_jobs(batch_id);
```

**Current Data**: 38 conversion jobs

**Migration Notes**:
- `output_size_bytes`: Changed to BIGINT for large files
- Boolean conversion: `delete_original` 0/1 → false/true
- Added CHECK constraint for status values
- Status values:
  - `pending`: Queued for processing
  - `processing`: Currently being converted
  - `completed`: Successfully finished
  - `failed`: Conversion error
  - `cancelled`: User cancelled

**Preset Examples** (from `src/config/presets.ts`):
- 1080p_h264, 1080p_h265, 1080p_av1
- 720p_h264, 720p_h265, 720p_av1
- original_h264, original_h265, original_av1

**VAAPI Codecs**:
- `h264_vaapi`: H.264 GPU encoding
- `hevc_vaapi`: H.265/HEVC GPU encoding
- `av1_vaapi`: AV1 GPU encoding (requires newer GPUs)

---

## 2. thumbnails

Video thumbnail images (one per video).

### SQLite Schema
```sql
CREATE TABLE thumbnails (
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

CREATE INDEX idx_thumbnails_video ON thumbnails(video_id);
```

### PostgreSQL Schema
```sql
CREATE TABLE thumbnails (
    id SERIAL PRIMARY KEY,
    video_id INTEGER NOT NULL UNIQUE,
    file_path TEXT NOT NULL,
    file_size_bytes INTEGER,
    timestamp_seconds REAL DEFAULT 5.0,
    width INTEGER,
    height INTEGER,
    generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);

CREATE INDEX idx_thumbnails_video ON thumbnails(video_id);
```

**Current Data**: 2,089 thumbnails (99.9% coverage)

**Migration Notes**:
- UNIQUE constraint on `video_id` enforces one thumbnail per video
- Default format: WebP (configured via env: THUMBNAIL_FORMAT)
- Default size: 320x240 (env: THUMBNAIL_SIZE)
- Default quality: 80 (env: THUMBNAIL_QUALITY)
- Frame selection:
  - By default: 20% of video duration (env: THUMBNAIL_POSITION_PERCENT)
  - Fallback: 5 seconds if duration unavailable (env: THUMBNAIL_TIMESTAMP)
  - Can override with `timestamp` or `positionPercent` in API

**Storage Path Pattern**:
```
data/thumbnails/thumbnail_{video_id}_{timestamp}.webp
```

---

## 3. storyboards

Video preview sprites for seek bar hover.

### SQLite Schema
```sql
CREATE TABLE storyboards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id INTEGER NOT NULL UNIQUE,
    sprite_path TEXT NOT NULL,
    vtt_path TEXT NOT NULL,
    tile_width INTEGER NOT NULL,
    tile_height INTEGER NOT NULL,
    tile_count INTEGER NOT NULL,
    interval_seconds REAL NOT NULL,
    sprite_size_bytes INTEGER,
    generated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);

CREATE INDEX idx_storyboards_video ON storyboards(video_id);
```

### PostgreSQL Schema
```sql
CREATE TABLE storyboards (
    id SERIAL PRIMARY KEY,
    video_id INTEGER NOT NULL UNIQUE,
    sprite_path TEXT NOT NULL,
    vtt_path TEXT NOT NULL,
    tile_width INTEGER NOT NULL,
    tile_height INTEGER NOT NULL,
    tile_count INTEGER NOT NULL,
    interval_seconds REAL NOT NULL,
    sprite_size_bytes INTEGER,
    generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);

CREATE INDEX idx_storyboards_video ON storyboards(video_id);
```

**Current Data**: 294 storyboards (14% coverage)

**Migration Notes**:
- UNIQUE constraint on `video_id` enforces one storyboard per video
- **Sprite sheet**: Single image with grid of thumbnails
- **VTT file**: WebVTT format mapping timestamps to sprite coordinates
- Common configurations:
  - 5-10 second intervals
  - Tile sizes: 256x144, 512x288 (16:9 aspect)
  - Variable tile count based on video duration

**Sample Data**:
| video_id | tile_width | tile_height | tile_count | interval | sprite_size |
|----------|------------|-------------|------------|----------|-------------|
| 2052 | 512 | 288 | 73 | 10.0s | 1.0 MB |
| 2053 | 256 | 144 | 163 | 5.0s | 0.9 MB |

**Storage Path Pattern**:
```
data/storyboards/storyboard_{video_id}_{timestamp}.jpg
data/storyboards/storyboard_{video_id}_{timestamp}.vtt
```

**VTT Format Example**:
```vtt
WEBVTT

00:00:00.000 --> 00:00:05.000
storyboard_2053_1768193414269.jpg#xywh=0,0,256,144

00:00:05.000 --> 00:00:10.000
storyboard_2053_1768193414269.jpg#xywh=256,0,256,144
```

---

## Processing Workflow

### Thumbnail Generation

1. Auto-generated during directory scan (if missing)
2. Manual generation via `POST /api/videos/:id/thumbnails`
3. Uses FFmpeg to extract frame at percentage position
4. Converts to WebP with quality compression
5. Stores file path in database

### Storyboard Generation

1. Manual generation via API (not auto-generated)
2. Extracts frames at regular intervals
3. Combines into sprite sheet using FFmpeg tile filter
4. Generates VTT file with timestamp mappings
5. Used by video player for seek bar preview

### Conversion Processing

1. User submits job via `POST /api/videos/:id/convert`
2. Job created with status `pending`
3. Queue processor picks up job (one at a time)
4. Status updates to `processing`
5. FFmpeg spawned with VAAPI GPU encoding
6. Progress parsed from stderr and broadcast via WebSocket
7. On completion: status → `completed`, output_path stored
8. On error: status → `failed`, error_message stored

**WebSocket Events**:
- `conversion:started` - Job begins
- `conversion:progress` - Real-time percentage updates
- `conversion:completed` - Job finished
- `conversion:failed` - Job error

---

## Data Integrity Checks

```sql
-- Videos without thumbnails
SELECT v.id, v.file_name
FROM videos v
LEFT JOIN thumbnails t ON t.video_id = v.id
WHERE t.id IS NULL AND v.is_available = true;

-- Videos without storyboards
SELECT v.id, v.file_name
FROM videos v
LEFT JOIN storyboards s ON s.video_id = v.id
WHERE s.id IS NULL AND v.is_available = true;

-- Conversion job statistics
SELECT
    status,
    COUNT(*) as count,
    AVG(EXTRACT(EPOCH FROM (completed_at - started_at))) as avg_duration_seconds,
    SUM(output_size_bytes) / 1024 / 1024 / 1024 as total_output_gb
FROM conversion_jobs
WHERE status IN ('completed', 'failed')
GROUP BY status;

-- Storage breakdown
SELECT
    'thumbnails' as type,
    COUNT(*) as count,
    SUM(file_size_bytes) / 1024 / 1024 as total_mb
FROM thumbnails
UNION ALL
SELECT
    'storyboards' as type,
    COUNT(*) as count,
    SUM(sprite_size_bytes) / 1024 / 1024 as total_mb
FROM storyboards
UNION ALL
SELECT
    'conversions' as type,
    COUNT(*) as count,
    SUM(output_size_bytes) / 1024 / 1024 / 1024 * 1024 as total_mb
FROM conversion_jobs
WHERE status = 'completed';
```

## PostgreSQL Enhancements

```sql
-- Add CHECK constraints
ALTER TABLE thumbnails ADD CONSTRAINT check_timestamp_positive
    CHECK (timestamp_seconds >= 0);

ALTER TABLE storyboards ADD CONSTRAINT check_positive_dimensions
    CHECK (tile_width > 0 AND tile_height > 0 AND tile_count > 0);

-- Add partial index for active jobs
CREATE INDEX idx_conversion_jobs_active
    ON conversion_jobs(created_at)
    WHERE status IN ('pending', 'processing');
```
