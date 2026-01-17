# Current Data Summary

Snapshot of existing data as of migration planning (2026-01-16).

## Database Overview

**SQLite Database**: `data/database.db`
**Total Tables**: 33 (excluding sqlite_sequence)
**Database Size**: ~500 MB (estimated)

---

## Data Volumes by Category

### Core System (Low Volume)

| Table | Rows | Notes |
|-------|------|-------|
| users | 1 | Single-user system |
| sessions | 15 | Active sessions (cleanup recommended) |
| app_settings | 6 | Configuration values |
| watched_directories | 1 | Single video source directory |

**Migration Priority**: High (foundation tables)
**Migration Complexity**: Low

---

### Media Management (High Volume)

| Table | Rows | Storage | Notes |
|-------|------|---------|-------|
| videos | 2,091 | Primary | Core content table |
| scan_logs | 123 | ~50 KB | Historical scan data |

**Total Videos**: 2,091
**Available**: ~2,091 (assumed, verify with is_available = true)
**Unavailable**: 0 (verify)

**Video Characteristics** (sample from stats):
- Average file size: ~1-2 GB (estimated)
- Total storage: ~2-4 TB (estimated)
- Formats: MKV, MP4 (verify with codec breakdown)
- Resolutions: Mix of 720p, 1080p, 4K (verify)

**Migration Priority**: High
**Migration Complexity**: Medium (large data volume)

---

### Content Organization (Medium Volume)

| Table | Rows | Coverage | Notes |
|-------|------|----------|-------|
| creators | 161 | - | Content creators/performers |
| studios | 22 | - | Production studios |
| platforms | 7 | - | External platforms |
| tags | 10 | - | Hierarchical tags (low adoption) |
| video_creators | 214 | 10.2% | 214 of 2,091 videos tagged |
| video_studios | 143 | 6.8% | 143 of 2,091 videos tagged |
| video_tags | 25 | 1.2% | Only 25 videos tagged! |
| creator_platforms | 6 | - | Platform profiles |
| creator_social_links | 9 | - | Social media links |
| creator_studios | 2 | - | Creator/studio associations |
| studio_social_links | 1 | - | Studio social links |

**Key Insights**:
- **Low tag adoption**: Only 1.2% of videos have tags (opportunity for improvement)
- **Creator coverage**: 10% of videos have creator associations
- **Studio coverage**: 7% have studio associations
- **Face recognition could dramatically improve**: Automated creator tagging

**Platform Distribution**:
1. Patreon
2. OnlyFans
3. Fansly
4. ManyVids
5. Chaturbate
6. (2 others)

**Migration Priority**: Medium
**Migration Complexity**: Medium (foreign key dependencies)

---

### User Features (Low-Medium Volume)

| Table | Rows | Coverage | Notes |
|-------|------|----------|-------|
| video_stats | 290 | 13.9% | Watch history for 290 videos |
| favorites | 15 | 0.7% | 15 favorite videos |
| playlist_videos | 18 | 0.9% | 18 videos in playlists |
| bookmarks | 2 | 0.1% | Minimal bookmark usage |
| playlists | 1 | - | Single playlist created |
| ratings | 0 | 0% | **Empty - no ratings yet** |
| video_metadata | 0 | 0% | **Empty - no custom metadata** |

**Key Insights**:
- **Active usage**: 290 videos watched (13.9% of library)
- **Favorites**: Small but active feature
- **Ratings**: Feature exists but unused (consider UI improvements)
- **Bookmarks**: Underutilized feature

**Migration Priority**: Medium
**Migration Complexity**: Low

---

### Media Processing (High Volume)

| Table | Rows | Coverage | Notes |
|-------|------|----------|-------|
| thumbnails | 2,089 | 99.9% | Nearly complete coverage! |
| storyboards | 294 | 14.1% | Selective generation |
| conversion_jobs | 38 | 1.8% | Conversion history |

**Key Insights**:
- **Thumbnail coverage**: Excellent (99.9%)
- **Storyboard coverage**: Selective (resource-intensive)
- **Conversions**: 38 jobs completed/failed

**Storage Estimates**:
- Thumbnails: ~200-500 MB (2,089 × ~100-250 KB each)
- Storyboards: ~200-300 MB (294 × ~700 KB - 1 MB each)
- Conversions: Variable (depends on success rate)

**Migration Priority**: Medium
**Migration Complexity**: Low (already generated, just metadata)

---

### Statistics (Low Volume, High Value)

| Table | Rows | Frequency | Notes |
|-------|------|-----------|-------|
| stats_storage_snapshots | 41 | Hourly | ~2 days of data |
| stats_library_snapshots | 5 | Daily | ~5 days of data |
| stats_content_snapshots | 5 | Daily | ~5 days of data |
| stats_usage_snapshots | 5 | Daily | ~5 days of data |

**Key Insights**:
- Recent feature (< 1 week old)
- Limited historical data
- Can safely truncate or migrate all

**Migration Priority**: Low (can regenerate)
**Migration Complexity**: Low

---

### Triage System (No Data)

| Table | Rows | Notes |
|-------|------|-------|
| triage_progress | 0 | **Empty - feature unused or recently added** |

**Migration Priority**: Low
**Migration Complexity**: Low

---

## Migration Data Size Estimates

### Row Counts

| Category | Tables | Total Rows | Priority |
|----------|--------|------------|----------|
| Core System | 4 | 23 | High |
| Media Management | 2 | 2,214 | High |
| Content Organization | 11 | 600 | Medium |
| User Features | 7 | 325 | Medium |
| Media Processing | 3 | 2,421 | Medium |
| Statistics | 4 | 56 | Low |
| Triage | 1 | 0 | Low |
| **TOTAL** | **33** | **5,639** | - |

### Storage Breakdown

| Component | Size Estimate | Notes |
|-----------|---------------|-------|
| Videos (files) | 2-4 TB | Not migrated, file system only |
| Thumbnails (files) | 200-500 MB | File system |
| Storyboards (files) | 200-300 MB | File system |
| Conversions (files) | Variable | File system |
| Database | 500 MB | SQLite → PostgreSQL |
| Profile pictures | ~50 MB | File system |

**Total file system storage**: ~3-5 TB
**Database-only migration**: ~500 MB

---

## Data Quality Issues

### Missing/Incomplete Data

1. **Tags**: Only 1.2% of videos tagged
   - **Solution**: Face recognition can auto-suggest creators
   - **Action**: Implement triage workflow

2. **Ratings**: 0% of videos rated
   - **Possible cause**: Feature not visible in UI?
   - **Action**: Review UI/UX for ratings feature

3. **Storyboards**: 14% coverage
   - **Cause**: Resource-intensive generation
   - **Action**: Optional enhancement, not critical

4. **Creator associations**: Only 10% of videos
   - **Solution**: Face recognition will dramatically improve this
   - **Action**: Primary goal of PostgreSQL migration!

### Data Integrity

Run these queries before migration:

```sql
-- Orphaned records
SELECT 'video_creators' as table_name, COUNT(*) as orphans
FROM video_creators vc
LEFT JOIN videos v ON v.id = vc.video_id
WHERE v.id IS NULL
UNION ALL
SELECT 'thumbnails', COUNT(*)
FROM thumbnails t
LEFT JOIN videos v ON v.id = t.video_id
WHERE v.id IS NULL;

-- Duplicate hashes
SELECT file_hash, COUNT(*) as count
FROM videos
WHERE file_hash IS NOT NULL
GROUP BY file_hash
HAVING COUNT(*) > 1;

-- Videos with missing files
SELECT COUNT(*) FROM videos WHERE is_available = false;
```

---

## Recommended Migration Order

### Phase 1: Foundation (Day 1)
1. Core System tables (4 tables, 23 rows)
2. Media Management: videos only (2,091 rows)
3. Verify video file paths are accessible

### Phase 2: Content (Day 2)
1. Creators, Studios, Platforms, Tags (200 rows)
2. Relationship tables (384 rows)
3. Verify foreign key constraints

### Phase 3: Features (Day 3)
1. User Features (325 rows)
2. Media Processing (2,421 rows)
3. Test thumbnails and storyboards still accessible

### Phase 4: Analytics (Day 4)
1. Statistics tables (56 rows)
2. Triage (0 rows)
3. Set up scheduled snapshot generation

### Phase 5: Face Recognition (Days 5-7)
1. Create new tables
2. Deploy Python microservice
3. Test face detection on sample videos
4. Begin processing backlog

---

## Data Validation Checklist

After migration:

- [ ] Row counts match SQLite exactly
- [ ] All foreign keys validated
- [ ] File paths accessible from PostgreSQL server
- [ ] Thumbnail images load in UI
- [ ] Storyboard sprites and VTT files work
- [ ] Watch statistics preserved
- [ ] Playlists maintain correct order
- [ ] Tag hierarchy intact
- [ ] Conversion job history accessible
- [ ] Boolean values correctly converted (true/false not 1/0)
- [ ] Timestamps preserved (verify time zones)
- [ ] HNSW indexes created successfully
- [ ] Face recognition test successful on 10 videos

---

## PostgreSQL Size Projections

Based on current data:

| Component | Current (SQLite) | Projected (PostgreSQL) | Notes |
|-----------|------------------|------------------------|-------|
| Table data | ~400 MB | ~500 MB | +25% overhead |
| Indexes | ~100 MB | ~150 MB | More indexes + HNSW |
| Face embeddings | 0 MB | ~50 MB | 2,091 videos × 5 faces × 512 dim × 4 bytes ≈ 20 MB |
| **Total** | **500 MB** | **700 MB** | Initial size |

**1-Year Projection** (assuming 500 new videos):
- Videos: +500 rows
- Face detections: +2,500 faces
- Database size: ~900 MB

**Growth Rate**: ~200 MB/year (manageable)

---

## File System Migration

**Not migrating**:
- Video files (remain at current locations)
- Thumbnail files
- Storyboard files
- Conversion outputs
- Profile pictures

**Action Required**:
- Ensure PostgreSQL server can access file paths
- Consider using NFS or shared storage
- Or update file_path references to use new server paths

**Option A**: Same server (no changes needed)
**Option B**: Different server (need to update all file_path columns or mount NFS)
