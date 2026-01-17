# Database Indexes

Complete index documentation for all tables.

## Index Summary

**Total Indexes**: 56 (excluding primary keys and unique constraints)

### By Category

| Category | Table Count | Index Count |
|----------|-------------|-------------|
| Media Management | 2 | 17 |
| Content Organization | 11 | 15 |
| User Features | 7 | 10 |
| Media Processing | 3 | 4 |
| Statistics | 4 | 4 |
| Core System | 4 | 3 |
| Triage | 1 | 2 |
| Face Recognition (NEW) | 4 | ~8 |

---

## Core System Indexes

### sessions
```sql
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);
```

**Purpose**:
- `user_id`: Lookup all sessions for a user
- `expires_at`: Cleanup expired sessions efficiently

---

## Media Management Indexes

### videos (17 indexes!)

```sql
-- Foreign key lookups
CREATE INDEX idx_videos_directory ON videos(directory_id);

-- Unique lookups
CREATE INDEX idx_videos_file_path ON videos(file_path);
CREATE INDEX idx_videos_file_hash ON videos(file_hash);

-- Availability filtering
CREATE INDEX idx_videos_is_available ON videos(is_available);
CREATE INDEX idx_videos_directory_available ON videos(directory_id, is_available);

-- Search and filtering
CREATE INDEX idx_videos_file_name ON videos(file_name);
CREATE INDEX idx_videos_filesize ON videos(file_size_bytes);
CREATE INDEX idx_videos_duration ON videos(duration_seconds);
CREATE INDEX idx_videos_codec ON videos(codec);
CREATE INDEX idx_videos_audio_codec ON videos(audio_codec);
CREATE INDEX idx_videos_bitrate ON videos(bitrate);
CREATE INDEX idx_videos_fps ON videos(fps);
```

**Purpose**:
- Composite index `(directory_id, is_available)` optimizes directory scans
- Single-column indexes support search filters
- File hash index enables fast duplicate detection

**PostgreSQL Optimization**:
```sql
-- Add GIN index for full-text search on file_name and title
CREATE INDEX idx_videos_search_gin ON videos
    USING gin(to_tsvector('english', COALESCE(title, '') || ' ' || file_name));

-- Partial index for available videos only
CREATE INDEX idx_videos_available_created ON videos(created_at)
    WHERE is_available = true;
```

### scan_logs

```sql
CREATE INDEX idx_scan_logs_directory ON scan_logs(directory_id);
CREATE INDEX idx_scan_logs_started ON scan_logs(started_at);
CREATE INDEX idx_scan_logs_completed_at ON scan_logs(completed_at);
```

**Purpose**: Query scan history by directory and time range

---

## Content Organization Indexes

### tags

```sql
CREATE INDEX idx_tags_parent ON tags(parent_id);
```

**Purpose**: Efficient hierarchical tree traversal with recursive CTEs

### video_creators

```sql
CREATE INDEX idx_video_creators_video ON video_creators(video_id);
CREATE INDEX idx_video_creators_creator ON video_creators(creator_id);
```

**Purpose**: Bidirectional lookups for many-to-many relationship

### video_studios

```sql
CREATE INDEX idx_video_studios_video ON video_studios(video_id);
CREATE INDEX idx_video_studios_studio ON video_studios(studio_id);
```

### video_tags

```sql
CREATE INDEX idx_video_tags_video ON video_tags(video_id);
CREATE INDEX idx_video_tags_tag ON video_tags(tag_id);
```

### creator_studios

```sql
CREATE INDEX idx_creator_studios_creator ON creator_studios(creator_id);
CREATE INDEX idx_creator_studios_studio ON creator_studios(studio_id);
```

### creator_platforms

```sql
CREATE INDEX idx_creator_platforms_creator ON creator_platforms(creator_id);
CREATE INDEX idx_creator_platforms_platform ON creator_platforms(platform_id);
CREATE INDEX idx_creator_platforms_username ON creator_platforms(username);
```

**Purpose**: Username index enables searching creators by platform handle

### creator_social_links

```sql
CREATE INDEX idx_creator_social_links_creator ON creator_social_links(creator_id);
```

### studio_social_links

```sql
CREATE INDEX idx_studio_social_links_studio ON studio_social_links(studio_id);
```

---

## User Features Indexes

### playlist_videos

```sql
CREATE INDEX idx_playlist_videos_playlist ON playlist_videos(playlist_id, position);
CREATE INDEX idx_playlist_videos_video_id ON playlist_videos(video_id);
```

**Purpose**: Composite index `(playlist_id, position)` enables efficient ordered retrieval

### favorites

```sql
CREATE INDEX idx_favorites_user ON favorites(user_id);
CREATE INDEX idx_favorites_video_id ON favorites(video_id);
```

### bookmarks

```sql
CREATE INDEX idx_bookmarks_video ON bookmarks(video_id, timestamp_seconds);
CREATE INDEX idx_bookmarks_user ON bookmarks(user_id);
```

**Purpose**: Composite index `(video_id, timestamp_seconds)` for timeline queries

### ratings

```sql
CREATE INDEX idx_ratings_video ON ratings(video_id);
```

### video_stats

```sql
CREATE INDEX idx_video_stats_video ON video_stats(video_id);
CREATE INDEX idx_video_stats_user ON video_stats(user_id);
CREATE INDEX idx_video_stats_last_played ON video_stats(last_played_at);
```

**Purpose**: `last_played_at` index supports "recently watched" queries

### video_metadata

```sql
CREATE INDEX idx_video_metadata_video ON video_metadata(video_id);
CREATE INDEX idx_video_metadata_key ON video_metadata(key);
```

**Purpose**: Key index enables searching videos by metadata type

---

## Media Processing Indexes

### conversion_jobs

```sql
CREATE INDEX idx_conversion_jobs_video ON conversion_jobs(video_id);
CREATE INDEX idx_conversion_jobs_status ON conversion_jobs(status);
CREATE INDEX idx_conversion_jobs_batch ON conversion_jobs(batch_id);
```

**Purpose**:
- Status index for queue processing
- Batch index for bulk conversion operations

**PostgreSQL Enhancement**:
```sql
-- Partial index for active jobs only
CREATE INDEX idx_conversion_jobs_active ON conversion_jobs(created_at)
    WHERE status IN ('pending', 'processing');
```

### thumbnails

```sql
CREATE INDEX idx_thumbnails_video ON thumbnails(video_id);
```

**Note**: UNIQUE constraint on `video_id` already provides index

### storyboards

```sql
CREATE INDEX idx_storyboards_video ON storyboards(video_id);
```

**Note**: UNIQUE constraint on `video_id` already provides index

---

## Statistics Indexes

All stats tables follow the same pattern:

```sql
CREATE INDEX idx_stats_storage_created ON stats_storage_snapshots(created_at);
CREATE INDEX idx_stats_library_created ON stats_library_snapshots(created_at);
CREATE INDEX idx_stats_content_created ON stats_content_snapshots(created_at);
CREATE INDEX idx_stats_usage_created ON stats_usage_snapshots(created_at);
```

**Purpose**: Time-range queries for analytics dashboards

**PostgreSQL Enhancement**:
```sql
-- GIN indexes for JSONB breakdown columns
CREATE INDEX idx_stats_library_resolution_gin
    ON stats_library_snapshots USING gin(resolution_breakdown);

CREATE INDEX idx_stats_library_codec_gin
    ON stats_library_snapshots USING gin(codec_breakdown);

CREATE INDEX idx_stats_content_top_tags_gin
    ON stats_content_snapshots USING gin(top_tags);

CREATE INDEX idx_stats_usage_activity_gin
    ON stats_usage_snapshots USING gin(activity_by_hour);
```

---

## Triage System Indexes

### triage_progress

```sql
CREATE INDEX idx_triage_progress_user ON triage_progress(user_id);
CREATE INDEX idx_triage_progress_filter ON triage_progress(user_id, filter_key);
```

**Note**: UNIQUE constraint on `(user_id, filter_key)` already provides index

---

## Face Recognition Indexes (NEW)

### creator_face_embeddings

```sql
-- HNSW index for vector similarity search
CREATE INDEX idx_creator_faces_embedding ON creator_face_embeddings
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

-- Standard indexes
CREATE INDEX idx_creator_faces_creator ON creator_face_embeddings(creator_id);
CREATE INDEX idx_creator_faces_quality ON creator_face_embeddings(quality_score);
```

**HNSW Parameters**:
- `m = 16`: Number of connections per layer (higher = more accurate, slower)
- `ef_construction = 64`: Construction time parameter (higher = better index)
- `vector_cosine_ops`: Cosine distance operator

### video_face_detections

```sql
-- HNSW index for similarity search
CREATE INDEX idx_video_faces_embedding ON video_face_detections
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

-- Standard indexes
CREATE INDEX idx_video_faces_video ON video_face_detections(video_id);
CREATE INDEX idx_video_faces_status ON video_face_detections(match_status);
CREATE INDEX idx_video_faces_creator ON video_face_detections(matched_creator_id);
CREATE INDEX idx_video_faces_confidence ON video_face_detections(match_confidence);
```

**Purpose**:
- HNSW enables O(log n) similarity search vs O(n) sequential scan
- Status index for filtering pending/matched faces
- Confidence index for reviewing low-confidence matches

---

## Index Maintenance

### SQLite (Current)

SQLite auto-maintains indexes but doesn't provide size info. Indexes are stored in the same database file.

### PostgreSQL (After Migration)

```sql
-- Index sizes
SELECT
    schemaname,
    tablename,
    indexname,
    pg_size_pretty(pg_relation_size(indexrelid)) as index_size
FROM pg_stat_user_indexes
ORDER BY pg_relation_size(indexrelid) DESC;

-- Index usage statistics
SELECT
    schemaname,
    tablename,
    indexname,
    idx_scan as scans,
    idx_tup_read as tuples_read,
    idx_tup_fetch as tuples_fetched
FROM pg_stat_user_indexes
WHERE schemaname = 'public'
ORDER BY idx_scan DESC;

-- Unused indexes (candidates for removal)
SELECT
    schemaname,
    tablename,
    indexname
FROM pg_stat_user_indexes
WHERE idx_scan = 0
  AND indexrelname NOT LIKE 'pg_toast%'
ORDER BY pg_relation_size(indexrelid) DESC;

-- Rebuild indexes (after bulk data load)
REINDEX TABLE videos;
REINDEX INDEX idx_videos_file_hash;

-- Update statistics for query planner
ANALYZE videos;
```

---

## Performance Recommendations

### High-Priority Indexes (Already Created)

These indexes are critical for performance:

1. `idx_videos_directory_available` - Directory scans
2. `idx_videos_file_hash` - Duplicate detection
3. `idx_playlist_videos_playlist` - Ordered playlist queries
4. `idx_conversion_jobs_status` - Queue processing
5. `idx_creator_faces_embedding` - Face matching (NEW)
6. `idx_video_faces_embedding` - Face search (NEW)

### Consider Adding (PostgreSQL)

```sql
-- Full-text search
CREATE INDEX idx_videos_fulltext ON videos
    USING gin(to_tsvector('english', COALESCE(title, '') || ' ' || COALESCE(description, '') || ' ' || file_name));

-- Covering index for video list queries
CREATE INDEX idx_videos_list ON videos(is_available, created_at)
    INCLUDE (id, file_name, title, duration_seconds);

-- Partial index for recent videos
CREATE INDEX idx_videos_recent ON videos(created_at DESC)
    WHERE is_available = true AND created_at > NOW() - INTERVAL '30 days';

-- Multicolumn index for filtered searches
CREATE INDEX idx_videos_filter ON videos(is_available, codec, width, height);
```

### Index Bloat Prevention

```sql
-- Monitor index bloat
SELECT
    tablename,
    indexname,
    pg_size_pretty(pg_relation_size(indexrelid)) as size,
    idx_scan,
    idx_tup_read,
    idx_tup_fetch,
    pg_size_pretty(pg_relation_size(indexrelid) -
        pg_relation_size(indexrelid, 'fsm')) as bloat_estimate
FROM pg_stat_user_indexes
ORDER BY pg_relation_size(indexrelid) DESC;

-- Rebuild bloated indexes
REINDEX INDEX CONCURRENTLY idx_videos_file_hash;
```

---

## Migration Checklist

- [ ] Create all indexes in PostgreSQL schema
- [ ] Configure HNSW parameters for face recognition indexes
- [ ] Add GIN indexes for JSONB columns in stats tables
- [ ] Create partial indexes for common filtered queries
- [ ] Run ANALYZE after bulk data import
- [ ] Monitor index usage after 1 week
- [ ] Remove unused indexes
- [ ] Set up pg_cron for periodic REINDEX of high-churn tables
