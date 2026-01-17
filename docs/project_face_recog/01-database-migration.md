# Database Migration: SQLite to PostgreSQL + pgvector

This document covers the migration from SQLite to PostgreSQL with the pgvector extension for face recognition features.

## Table of Contents

- [Why PostgreSQL + pgvector?](#why-postgresql--pgvector)
- [Migration Strategy](#migration-strategy)
- [Infrastructure Setup](#infrastructure-setup)
- [Code Changes](#code-changes)
- [Schema Migration](#schema-migration)
- [Vector Query Examples](#vector-query-examples)

---

## Why PostgreSQL + pgvector?

| Feature            | SQLite        | PostgreSQL + pgvector                |
| ------------------ | ------------- | ------------------------------------ |
| Vector type        | BLOB (manual) | Native `vector(512)`                 |
| Similarity search  | O(n) in code  | O(log n) with HNSW                   |
| Concurrent writes  | Limited       | Full support                         |
| Scaling            | ~100K rows    | Millions+                            |
| Distance functions | Manual        | Built-in (cosine, L2, inner product) |

---

## Migration Strategy

### Phase 1: Infrastructure Setup

### Phase 2: Code Changes

### Phase 3: Schema Migration

---

## Infrastructure Setup

### Install PostgreSQL 16+

```bash
sudo apt install postgresql-16 postgresql-16-pgvector
```

### Create Database

```bash
sudo -u postgres createdb video_streaming
sudo -u postgres psql -d video_streaming -c "CREATE EXTENSION vector;"
```

---

## Code Changes

### Replace Bun SQLite with PostgreSQL Client

**Before** (`src/config/database.ts`):

```typescript
import { Database } from "bun:sqlite";
```

**After** (`src/config/database.ts`):

```typescript
import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
});

export function getDatabase() {
  return pool;
}

// Query helper for compatibility
export async function query<T>(sql: string, params?: any[]): Promise<T[]> {
  const result = await pool.query(sql, params);
  return result.rows;
}
```

---

## Schema Migration

### Key Changes for Existing Tables

- `INTEGER PRIMARY KEY` → `SERIAL PRIMARY KEY`
- `DATETIME` → `TIMESTAMP`
- `BOOLEAN` → `BOOLEAN` (same, but `true/false` not `1/0`)
- Add vector columns for face embeddings

### New Schema with pgvector

```sql
-- Enable pgvector
CREATE EXTENSION IF NOT EXISTS vector;

-- Existing tables (adapted for PostgreSQL)
CREATE TABLE creators (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    profile_picture_path TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE videos (
    id SERIAL PRIMARY KEY,
    file_path TEXT NOT NULL UNIQUE,
    title TEXT,
    duration_seconds REAL,
    width INTEGER,
    height INTEGER,
    codec TEXT,
    file_size_bytes BIGINT,
    file_hash TEXT,
    is_available BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- NEW: Face embeddings for creators (known faces)
CREATE TABLE creator_face_embeddings (
    id SERIAL PRIMARY KEY,
    creator_id INTEGER NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
    embedding vector(512) NOT NULL,  -- InsightFace buffalo_l produces 512-dim vectors
    source_type TEXT NOT NULL CHECK (source_type IN ('profile_picture', 'video_frame', 'manual')),
    source_path TEXT,
    quality_score REAL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- NEW: Detected faces in videos
CREATE TABLE video_face_detections (
    id SERIAL PRIMARY KEY,
    video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    frame_timestamp REAL NOT NULL,
    embedding vector(512) NOT NULL,
    bbox_x REAL NOT NULL,
    bbox_y REAL NOT NULL,
    bbox_width REAL NOT NULL,
    bbox_height REAL NOT NULL,
    quality_score REAL,
    matched_creator_id INTEGER REFERENCES creators(id) ON DELETE SET NULL,
    match_confidence REAL,
    match_status TEXT DEFAULT 'pending' CHECK (match_status IN ('pending', 'matched', 'rejected', 'manual')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- NEW: Face recognition configuration
CREATE TABLE face_recognition_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO face_recognition_config (key, value) VALUES
    ('match_threshold', '0.5'),
    ('auto_tag_threshold', '0.7'),
    ('frames_per_video', '5'),
    ('min_face_size', '64'),
    ('enabled', 'true');

-- HNSW index for fast similarity search
CREATE INDEX idx_creator_faces_embedding ON creator_face_embeddings
    USING hnsw (embedding vector_cosine_ops);

CREATE INDEX idx_video_faces_embedding ON video_face_detections
    USING hnsw (embedding vector_cosine_ops);

-- Standard indexes
CREATE INDEX idx_video_faces_video ON video_face_detections(video_id);
CREATE INDEX idx_video_faces_status ON video_face_detections(match_status);
CREATE INDEX idx_creator_faces_creator ON creator_face_embeddings(creator_id);
```

---

## Vector Query Examples

### Find Matching Creator for a Face

```sql
SELECT
    cfe.creator_id,
    c.name,
    1 - (cfe.embedding <=> $1::vector) AS similarity
FROM creator_face_embeddings cfe
JOIN creators c ON c.id = cfe.creator_id
WHERE 1 - (cfe.embedding <=> $1::vector) > 0.5  -- threshold
ORDER BY cfe.embedding <=> $1::vector
LIMIT 1;
```

### Find All Videos Containing a Creator

```sql
SELECT DISTINCT v.id, v.title
FROM video_face_detections vfd
JOIN videos v ON v.id = vfd.video_id
WHERE 1 - (vfd.embedding <=> (
    SELECT embedding FROM creator_face_embeddings
    WHERE creator_id = $1
    ORDER BY quality_score DESC
    LIMIT 1
)) > 0.6
ORDER BY v.created_at DESC;
```

### Cluster Unmatched Faces (Find Potential New Creators)

```sql
SELECT
    vfd1.id as face1_id,
    vfd2.id as face2_id,
    1 - (vfd1.embedding <=> vfd2.embedding) AS similarity
FROM video_face_detections vfd1
CROSS JOIN video_face_detections vfd2
WHERE vfd1.id < vfd2.id
    AND vfd1.match_status = 'pending'
    AND vfd2.match_status = 'pending'
    AND 1 - (vfd1.embedding <=> vfd2.embedding) > 0.7
ORDER BY similarity DESC
LIMIT 100;
```

---

## Complete Migration Documentation

The full migration documentation has been organized into a dedicated directory for better maintainability:

**[migration/](./migration/)** - Complete migration guide organized by category

### Quick Links

- [00-overview.md](./migration/00-overview.md) - Migration summary and strategy
- [01-core-system.md](./migration/01-core-system.md) - Auth and settings tables
- [02-media-management.md](./migration/02-media-management.md) - Videos and scanning
- [03-content-organization.md](./migration/03-content-organization.md) - Creators, studios, tags
- [04-user-features.md](./migration/04-user-features.md) - Playlists, favorites, bookmarks
- [05-media-processing.md](./migration/05-media-processing.md) - Conversions, thumbnails, storyboards
- [06-statistics.md](./migration/06-statistics.md) - Stats snapshot tables
- [07-triage.md](./migration/07-triage.md) - Triage workflow
- [08-indexes.md](./migration/08-indexes.md) - All 56 database indexes
- [data-summary.md](./migration/data-summary.md) - Current data volumes (2,091 videos, 5,639 total rows)

### Migration Summary

**Current State**:
- 33 tables (excluding sqlite_sequence)
- 2,091 videos with 99.9% thumbnail coverage
- 161 creators, 22 studios, 7 platforms
- ~500 MB database size
- ~3-5 TB total file storage

**Key Findings**:
- Low tag adoption (1.2% of videos)
- Low creator associations (10% of videos)
- Face recognition will dramatically improve content organization
- Empty tables: ratings, video_metadata, triage_progress

**Migration Priority**:
1. Core system + videos (foundation)
2. Content organization (creators, studios, tags)
3. User features + media processing
4. Statistics (can regenerate)
5. Face recognition (new tables)

---

## Related Documentation

- [Face Recognition Architecture](./02-face-recognition-architecture.md) - How to use the pgvector schema in the backend
- [Environment Configuration](./04-environment-config.md) - Database connection settings
