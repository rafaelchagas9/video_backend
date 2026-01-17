# Triage System Table

Table for tracking user progress through video organization workflows.

## 1. triage_progress

Tracks user's current position when organizing videos in batch.

### SQLite Schema
```sql
CREATE TABLE triage_progress (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    filter_key TEXT NOT NULL,
    last_video_id INTEGER,
    processed_count INTEGER DEFAULT 0,
    total_count INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (last_video_id) REFERENCES videos(id) ON DELETE SET NULL,
    UNIQUE(user_id, filter_key)
);

CREATE INDEX idx_triage_progress_user ON triage_progress(user_id);
CREATE INDEX idx_triage_progress_filter ON triage_progress(user_id, filter_key);
```

### PostgreSQL Schema
```sql
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
```

**Current Data**: 0 entries (table empty)

---

## Purpose

The triage system allows users to systematically work through large sets of videos requiring organization. For example:

### Use Cases

1. **Tag Untagged Videos**
   - Filter: "videos_without_tags"
   - User works through each video, adding tags
   - System remembers position for resume

2. **Assign Creators**
   - Filter: "videos_without_creators"
   - User identifies creators in each video
   - Progress tracked across sessions

3. **Add Ratings**
   - Filter: "videos_without_ratings"
   - User rates videos 1-5 stars
   - Can pause and resume anytime

4. **Generate Missing Media**
   - Filter: "videos_without_thumbnails"
   - Filter: "videos_without_storyboards"
   - Batch generate thumbnails/storyboards

---

## Schema Fields

| Field | Type | Description |
|-------|------|-------------|
| user_id | INTEGER | User performing triage |
| filter_key | TEXT | Identifies which filter/workflow |
| last_video_id | INTEGER | Last video processed (for resume) |
| processed_count | INTEGER | How many videos processed so far |
| total_count | INTEGER | Total videos in this triage session |
| created_at | TIMESTAMP | When triage session started |
| updated_at | TIMESTAMP | Last time user made progress |

---

## Filter Keys

Common filter keys used in the system:

| Filter Key | Query |
|------------|-------|
| videos_without_tags | `SELECT * FROM videos WHERE id NOT IN (SELECT video_id FROM video_tags)` |
| videos_without_creators | `SELECT * FROM videos WHERE id NOT IN (SELECT video_id FROM video_creators)` |
| videos_without_ratings | `SELECT * FROM videos WHERE id NOT IN (SELECT video_id FROM ratings)` |
| videos_without_thumbnails | `SELECT * FROM videos WHERE id NOT IN (SELECT video_id FROM thumbnails)` |
| videos_without_storyboards | `SELECT * FROM videos WHERE id NOT IN (SELECT video_id FROM storyboards)` |
| all_videos | `SELECT * FROM videos WHERE is_available = true` |
| new_videos | `SELECT * FROM videos WHERE created_at > DATE_SUB(NOW(), INTERVAL 7 DAY)` |

---

## Workflow Example

### 1. Start Triage Session

User clicks "Organize untagged videos" in UI:

```sql
-- Get total count
SELECT COUNT(*) FROM videos v
WHERE NOT EXISTS (SELECT 1 FROM video_tags vt WHERE vt.video_id = v.id)
  AND v.is_available = true;
-- Result: 1,850 videos

-- Create progress record
INSERT INTO triage_progress (user_id, filter_key, total_count)
VALUES (1, 'videos_without_tags', 1850);
```

### 2. Process Videos

User tags 10 videos, then takes a break:

```sql
-- Update progress after each video
UPDATE triage_progress
SET last_video_id = 1234,
    processed_count = processed_count + 1,
    updated_at = CURRENT_TIMESTAMP
WHERE user_id = 1 AND filter_key = 'videos_without_tags';
```

### 3. Resume Session

User returns later:

```sql
-- Get next video after last processed
SELECT v.* FROM videos v
WHERE NOT EXISTS (SELECT 1 FROM video_tags vt WHERE vt.video_id = v.id)
  AND v.is_available = true
  AND v.id > (
      SELECT last_video_id FROM triage_progress
      WHERE user_id = 1 AND filter_key = 'videos_without_tags'
  )
ORDER BY v.id
LIMIT 1;
```

### 4. Complete Session

When all videos processed or user abandons:

```sql
-- Mark as complete (optional)
DELETE FROM triage_progress
WHERE user_id = 1 AND filter_key = 'videos_without_tags';

-- Or reset
UPDATE triage_progress
SET last_video_id = NULL,
    processed_count = 0,
    updated_at = CURRENT_TIMESTAMP
WHERE user_id = 1 AND filter_key = 'videos_without_tags';
```

---

## Migration Notes

- Table is currently empty, so migration is straightforward
- UNIQUE constraint on (user_id, filter_key) enforces one session per filter type
- Foreign key to videos uses `ON DELETE SET NULL` so deleted videos don't break progress

---

## PostgreSQL Enhancements

```sql
-- Add completion percentage computed column
ALTER TABLE triage_progress ADD COLUMN completion_percent REAL
GENERATED ALWAYS AS (
    CASE
        WHEN total_count > 0
        THEN (processed_count::REAL / total_count::REAL) * 100
        ELSE 0
    END
) STORED;

-- Add index for abandoned sessions
CREATE INDEX idx_triage_progress_stale
    ON triage_progress(updated_at)
    WHERE processed_count > 0 AND updated_at < NOW() - INTERVAL '7 days';

-- Add CHECK constraint
ALTER TABLE triage_progress ADD CONSTRAINT check_counts_valid
    CHECK (processed_count >= 0 AND processed_count <= COALESCE(total_count, processed_count));
```

---

## Example Queries

```sql
-- Active triage sessions
SELECT
    tp.filter_key,
    tp.processed_count,
    tp.total_count,
    ROUND((tp.processed_count::REAL / NULLIF(tp.total_count, 0)) * 100, 2) as progress_pct,
    tp.updated_at
FROM triage_progress tp
WHERE tp.user_id = 1
ORDER BY tp.updated_at DESC;

-- Stale sessions (not updated in 7 days)
SELECT
    tp.filter_key,
    tp.processed_count,
    tp.total_count,
    AGE(NOW(), tp.updated_at) as time_since_update
FROM triage_progress tp
WHERE tp.updated_at < NOW() - INTERVAL '7 days'
ORDER BY tp.updated_at;

-- Cleanup stale sessions
DELETE FROM triage_progress
WHERE updated_at < NOW() - INTERVAL '30 days';
```

---

## Frontend Integration

Typical UI workflow:

```typescript
// Start triage session
const response = await fetch('/api/triage/start', {
    method: 'POST',
    body: JSON.stringify({ filter: 'videos_without_tags' })
});

// Get next video
const nextVideo = await fetch('/api/triage/next?filter=videos_without_tags');

// Mark video as processed
await fetch('/api/triage/progress', {
    method: 'PUT',
    body: JSON.stringify({
        filter: 'videos_without_tags',
        video_id: 1234
    })
});

// Get progress stats
const stats = await fetch('/api/triage/stats?filter=videos_without_tags');
// { processed: 15, total: 1850, percent: 0.81 }
```

---

## Related Statistics

The `stats_content_snapshots` table tracks high-level organization completeness:

```sql
-- Compare triage progress to overall stats
SELECT
    s.videos_without_tags,
    s.videos_without_creators,
    s.videos_without_thumbnails,
    tp.processed_count as tags_triage_processed
FROM stats_content_snapshots s
CROSS JOIN LATERAL (
    SELECT processed_count
    FROM triage_progress
    WHERE filter_key = 'videos_without_tags'
) tp
ORDER BY s.created_at DESC
LIMIT 1;
```
