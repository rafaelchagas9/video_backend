# Content Organization Tables

Tables for creators, studios, platforms, tags, and their relationships to videos.

## Overview

This system organizes videos through multiple dimensions:
- **Creators**: Performers/content creators
- **Studios**: Production companies
- **Platforms**: External platforms (Patreon, OnlyFans, etc.)
- **Tags**: Hierarchical categorization

## 1. creators

Content creators/performers.

### SQLite Schema
```sql
CREATE TABLE creators (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    profile_picture_path TEXT
);
```

### PostgreSQL Schema
```sql
CREATE TABLE creators (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    profile_picture_path TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

**Current Data**: 161 creators

---

## 2. studios

Production studios.

### SQLite Schema
```sql
CREATE TABLE studios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    profile_picture_path TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### PostgreSQL Schema
```sql
CREATE TABLE studios (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    profile_picture_path TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

**Current Data**: 22 studios

**Sample Data**:
- Hogtied
- Pure Taboo
- Kink

---

## 3. platforms

External content platforms.

### SQLite Schema
```sql
CREATE TABLE platforms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    base_url TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### PostgreSQL Schema
```sql
CREATE TABLE platforms (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    base_url TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

**Current Data**: 7 platforms

**Sample Data**:
| ID | Name | Base URL |
|----|------|----------|
| 1 | Patreon | https://patreon.com |
| 2 | OnlyFans | https://onlyfans.com |
| 3 | Fansly | https://fansly.com |
| 4 | ManyVids | https://manyvids.com |
| 5 | Chaturbate | https://chaturbate.com |

---

## 4. tags

Hierarchical tagging system with parent/child relationships.

### SQLite Schema
```sql
CREATE TABLE tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    parent_id INTEGER,
    description TEXT,
    color TEXT DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (parent_id) REFERENCES tags(id) ON DELETE CASCADE,
    UNIQUE(name, parent_id)
);

CREATE INDEX idx_tags_parent ON tags(parent_id);
```

### PostgreSQL Schema
```sql
CREATE TABLE tags (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    parent_id INTEGER,
    description TEXT,
    color TEXT DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (parent_id) REFERENCES tags(id) ON DELETE CASCADE,
    UNIQUE(name, parent_id)
);

CREATE INDEX idx_tags_parent ON tags(parent_id);
```

**Current Data**: 10 tags

**Migration Notes**:
- Self-referencing foreign key for hierarchy
- `UNIQUE(name, parent_id)` allows same name under different parents
- Color field added recently (may be NULL for older tags)
- Uses recursive CTEs for tree traversal queries

---

## Relationship Tables

### 5. video_creators

Many-to-many relationship: videos ↔ creators.

```sql
-- SQLite
CREATE TABLE video_creators (
    video_id INTEGER NOT NULL,
    creator_id INTEGER NOT NULL,
    PRIMARY KEY (video_id, creator_id),
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
    FOREIGN KEY (creator_id) REFERENCES creators(id) ON DELETE CASCADE
);

CREATE INDEX idx_video_creators_video ON video_creators(video_id);
CREATE INDEX idx_video_creators_creator ON video_creators(creator_id);

-- PostgreSQL (same schema, just documenting)
CREATE TABLE video_creators (
    video_id INTEGER NOT NULL,
    creator_id INTEGER NOT NULL,
    PRIMARY KEY (video_id, creator_id),
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
    FOREIGN KEY (creator_id) REFERENCES creators(id) ON DELETE CASCADE
);

CREATE INDEX idx_video_creators_video ON video_creators(video_id);
CREATE INDEX idx_video_creators_creator ON video_creators(creator_id);
```

**Current Data**: 214 relationships

---

### 6. video_studios

Many-to-many relationship: videos ↔ studios.

```sql
CREATE TABLE video_studios (
    video_id INTEGER NOT NULL,
    studio_id INTEGER NOT NULL,
    PRIMARY KEY (video_id, studio_id),
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
    FOREIGN KEY (studio_id) REFERENCES studios(id) ON DELETE CASCADE
);

CREATE INDEX idx_video_studios_video ON video_studios(video_id);
CREATE INDEX idx_video_studios_studio ON video_studios(studio_id);
```

**Current Data**: 143 relationships

---

### 7. video_tags

Many-to-many relationship: videos ↔ tags.

```sql
CREATE TABLE video_tags (
    video_id INTEGER NOT NULL,
    tag_id INTEGER NOT NULL,
    PRIMARY KEY (video_id, tag_id),
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
    FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);

CREATE INDEX idx_video_tags_video ON video_tags(video_id);
CREATE INDEX idx_video_tags_tag ON video_tags(tag_id);
```

**Current Data**: 25 relationships

---

### 8. creator_studios

Many-to-many relationship: creators ↔ studios.

```sql
CREATE TABLE creator_studios (
    creator_id INTEGER NOT NULL,
    studio_id INTEGER NOT NULL,
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (creator_id, studio_id),
    FOREIGN KEY (creator_id) REFERENCES creators(id) ON DELETE CASCADE,
    FOREIGN KEY (studio_id) REFERENCES studios(id) ON DELETE CASCADE
);

CREATE INDEX idx_creator_studios_creator ON creator_studios(creator_id);
CREATE INDEX idx_creator_studios_studio ON creator_studios(studio_id);
```

**PostgreSQL**: Change `DATETIME` → `TIMESTAMP`

**Current Data**: 2 relationships

---

### 9. creator_platforms

Creator profiles on external platforms.

```sql
CREATE TABLE creator_platforms (
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

CREATE INDEX idx_creator_platforms_creator ON creator_platforms(creator_id);
CREATE INDEX idx_creator_platforms_platform ON creator_platforms(platform_id);
CREATE INDEX idx_creator_platforms_username ON creator_platforms(username);
```

**PostgreSQL**:
- Change `SERIAL PRIMARY KEY`
- Boolean: `0` → `false`
- `DATETIME` → `TIMESTAMP`

**Current Data**: 6 platform profiles

---

### 10. creator_social_links

Social media links for creators.

```sql
CREATE TABLE creator_social_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    creator_id INTEGER NOT NULL,
    platform_name TEXT NOT NULL,
    url TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (creator_id) REFERENCES creators(id) ON DELETE CASCADE
);

CREATE INDEX idx_creator_social_links_creator ON creator_social_links(creator_id);
```

**PostgreSQL**: Standard conversions

**Current Data**: 9 social links

---

### 11. studio_social_links

Social media links for studios.

```sql
CREATE TABLE studio_social_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    studio_id INTEGER NOT NULL,
    platform_name TEXT NOT NULL,
    url TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (studio_id) REFERENCES studios(id) ON DELETE CASCADE
);

CREATE INDEX idx_studio_social_links_studio ON studio_social_links(studio_id);
```

**PostgreSQL**: Standard conversions

**Current Data**: 1 social link

---

## Migration Order

Due to foreign key dependencies, migrate in this order:

1. `creators`
2. `studios`
3. `platforms`
4. `tags` (handle self-references carefully)
5. `video_creators` (requires videos + creators)
6. `video_studios` (requires videos + studios)
7. `video_tags` (requires videos + tags)
8. `creator_studios` (requires creators + studios)
9. `creator_platforms` (requires creators + platforms)
10. `creator_social_links` (requires creators)
11. `studio_social_links` (requires studios)

## Data Integrity Checks

```sql
-- Orphaned relationships (should be 0)
SELECT COUNT(*) FROM video_creators vc
LEFT JOIN videos v ON v.id = vc.video_id
WHERE v.id IS NULL;

SELECT COUNT(*) FROM video_creators vc
LEFT JOIN creators c ON c.id = vc.creator_id
WHERE c.id IS NULL;

-- Tag hierarchy depth
WITH RECURSIVE tag_tree AS (
    SELECT id, name, parent_id, 0 as depth
    FROM tags WHERE parent_id IS NULL
    UNION ALL
    SELECT t.id, t.name, t.parent_id, tt.depth + 1
    FROM tags t
    JOIN tag_tree tt ON t.parent_id = tt.id
)
SELECT MAX(depth) as max_depth FROM tag_tree;

-- Creators without any videos
SELECT c.id, c.name
FROM creators c
LEFT JOIN video_creators vc ON vc.creator_id = c.id
WHERE vc.creator_id IS NULL;
```
