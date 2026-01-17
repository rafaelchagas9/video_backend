# Database Migration Overview

## Summary

Complete migration from SQLite to PostgreSQL 16+ with pgvector extension.

**Total Tables**: 33 (excluding sqlite_sequence)
**Current Data Volume**: ~2,091 videos with extensive metadata

## Table Categories

### 1. Core System (4 tables)
- `users` - Single user authentication
- `sessions` - Session-based auth tokens
- `app_settings` - Global configuration
- `watched_directories` - Video source directories

### 2. Media Management (2 tables)
- `videos` - Core video metadata and file information
- `scan_logs` - Directory scan history

### 3. Content Organization (11 tables)
- `creators` - Content creators/performers
- `studios` - Production studios
- `platforms` - External platforms (Patreon, OnlyFans, etc.)
- `tags` - Hierarchical tagging system
- `video_creators` - Many-to-many: videos ↔ creators
- `video_studios` - Many-to-many: videos ↔ studios
- `video_tags` - Many-to-many: videos ↔ tags
- `creator_platforms` - Creator profiles on platforms
- `creator_social_links` - Social media links for creators
- `creator_studios` - Many-to-many: creators ↔ studios
- `studio_social_links` - Social media links for studios

### 4. User Features (6 tables)
- `playlists` - User-created playlists
- `playlist_videos` - Playlist contents with ordering
- `favorites` - Favorited videos
- `bookmarks` - Timestamp bookmarks in videos
- `ratings` - 1-5 star ratings with comments
- `video_stats` - Watch statistics per user/video
- `video_metadata` - Custom key-value metadata

### 5. Media Processing (3 tables)
- `conversion_jobs` - GPU-accelerated video conversion queue
- `thumbnails` - Video thumbnail images
- `storyboards` - Video preview sprites for seek bar

### 6. Statistics (4 tables)
- `stats_storage_snapshots` - Storage usage over time (hourly)
- `stats_library_snapshots` - Library metrics (daily)
- `stats_content_snapshots` - Content organization metrics (daily)
- `stats_usage_snapshots` - Watch statistics (daily)

### 7. Triage System (1 table)
- `triage_progress` - User progress through video organization workflows

### 8. Face Recognition (NEW - 4 tables)
- `creator_face_embeddings` - Known face embeddings for creators
- `video_face_detections` - Detected faces in videos
- `face_recognition_config` - Face recognition settings
- `face_match_queue` - Processing queue for face matching jobs

## Current Data Volumes

| Table | Row Count | Notes |
|-------|-----------|-------|
| videos | 2,091 | Core content |
| thumbnails | 2,089 | Nearly complete coverage |
| creators | 161 | Content creators |
| video_creators | 214 | Creator associations |
| storyboards | 294 | Video preview sprites |
| video_stats | 290 | Watch history |
| video_studios | 143 | Studio associations |
| scan_logs | 123 | Scan history |
| conversion_jobs | 38 | Conversion history |
| stats_storage_snapshots | 41 | Hourly snapshots |
| studios | 22 | Production studios |
| video_tags | 25 | Tag associations |
| playlist_videos | 18 | Playlist contents |
| sessions | 15 | Active sessions |
| favorites | 15 | Favorite videos |
| tags | 10 | Hierarchical tags |
| creator_social_links | 9 | Social links |
| platforms | 7 | External platforms |
| creator_platforms | 6 | Platform profiles |
| app_settings | 6 | Configuration |
| stats_* | 5 each | Recent snapshots |
| creator_studios | 2 | Creator/studio links |
| bookmarks | 2 | Video bookmarks |
| studio_social_links | 1 | Social links |
| playlists | 1 | User playlist |
| watched_directories | 1 | Source directory |
| users | 1 | Single user |

**Empty tables**: ratings, video_metadata, triage_progress

## Migration Strategy

### Phase 1: Schema Design
1. Convert SQLite types to PostgreSQL equivalents
2. Add vector columns for face embeddings
3. Create HNSW indexes for similarity search
4. Preserve all foreign key relationships

### Phase 2: Data Migration
1. Export SQLite data to JSON/CSV
2. Transform data types (DATETIME → TIMESTAMP, BOOLEAN 1/0 → true/false)
3. Import into PostgreSQL maintaining referential integrity
4. Verify row counts and data integrity

### Phase 3: Code Migration
1. Replace `bun:sqlite` with `pg` (node-postgres)
2. Update query syntax (named parameters, RETURNING clause)
3. Update all services to use async database operations
4. Update tests to use PostgreSQL

### Phase 4: Face Recognition Integration
1. Add new tables for face embeddings
2. Create indexes for vector similarity search
3. Integrate Python microservice
4. Add face recognition API endpoints

## Key Migration Challenges

### Type Conversions

| SQLite | PostgreSQL | Notes |
|--------|-----------|-------|
| `INTEGER PRIMARY KEY AUTOINCREMENT` | `SERIAL PRIMARY KEY` | Auto-increment sequences |
| `DATETIME` | `TIMESTAMP` | No timezone support needed |
| `BOOLEAN` (1/0) | `BOOLEAN` (true/false) | Value transformation required |
| `INTEGER` | `INTEGER` or `BIGINT` | Use BIGINT for file_size_bytes |
| `REAL` | `REAL` or `DOUBLE PRECISION` | Preserve precision |
| `TEXT` | `TEXT` or `VARCHAR` | TEXT preferred for flexibility |

### Query Syntax Changes

1. **Parameter Placeholders**: `?` → `$1, $2, $3`
2. **RETURNING Clause**: Native support for `INSERT ... RETURNING *`
3. **Boolean Literals**: `1/0` → `true/false`
4. **Date Functions**: `CURRENT_TIMESTAMP` works in both
5. **String Concatenation**: `||` works in both
6. **LIMIT/OFFSET**: Same syntax

### Foreign Key Dependencies

Migration order must respect foreign key relationships:

1. Users
2. Watched directories
3. Videos
4. Creators, Studios, Platforms, Tags
5. Junction tables (video_creators, video_tags, etc.)
6. Dependent tables (thumbnails, storyboards, etc.)
7. Stats tables

## Related Documentation

- [01-core-system.md](./01-core-system.md) - Auth and settings
- [02-media-management.md](./02-media-management.md) - Videos and scanning
- [03-content-organization.md](./03-content-organization.md) - Creators, studios, tags
- [04-user-features.md](./04-user-features.md) - Playlists, favorites, bookmarks
- [05-media-processing.md](./05-media-processing.md) - Conversions, thumbnails
- [06-statistics.md](./06-statistics.md) - Stats snapshots
- [07-triage.md](./07-triage.md) - Triage workflow
- [08-indexes.md](./08-indexes.md) - All database indexes
- [data-summary.md](./data-summary.md) - Current data analysis
