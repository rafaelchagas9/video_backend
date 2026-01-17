# Media Tagging Improvements Plan

## Overview

This document outlines the comprehensive improvement plan for the video streaming backend's media tagging capabilities. The plan is designed to address the challenge of efficiently tagging and organizing 2000+ untagged videos from adult content platforms (OnlyFans, Fansly, Pornhub, etc.).

---

## Current Situation Analysis

### Strengths

- ✅ Robust bulk operations (creators, studios, tags)
- ✅ Triage queue system with progress tracking
- ✅ Platform profile management infrastructure
- ✅ Compression suggestions algorithm
- ✅ Path/directory info available during scanning
- ✅ Technical metadata extraction (FFmpeg)

### Critical Gaps

- ❌ No path-based auto-tagging from folder structures
- ❌ No AI/content recognition for automatic tagging
- ❌ No pattern rules engine
- ❌ No automation hooks during video indexing
- ❌ No face recognition/identification system
- ❌ No bulk apply with conditional filters

---

## Problem Statement

**Challenge**: 2000+ videos with generic filenames need efficient tagging workflow.

**Requirements**:

- Manual tagging efficiency (Phase 1)
- Automated future tagging (Phase 2)
- AI-powered face recognition (Phase 3)
- Platform integration (Phase 4)
- Advanced workflow features (Phase 5)

---

## Phase 1: Quick Wins for Backlog Clearing

**Timeline**: 2-3 weeks  
**Goal**: Dramatically speed up manual tagging of existing 2000+ videos

### 1.1 Enhanced Triage Queue with Quick Actions

**Features**:

- Split-screen endpoint: video details + tagging panel
- Keyboard shortcuts for common actions
- Auto-suggest last 5 used creators/studios/tags
- Batch mode: apply same tags to multiple videos in queue
- Quick-create modals for new entities (2-click workflow)

**Endpoints**:

```
GET  /api/videos/triage/next          // Get next video with context
POST /api/videos/triage/bulk-actions  // Apply actions to multiple videos
GET  /api/videos/triage/statistics    // Queue progress metrics
```

**Benefits**: Reduce average tagging time from 2 min to 30 sec → save ~57 hours

### 1.2 Smart Bulk Apply with Filters

**New Endpoint**:

```
POST /api/videos/bulk/conditional-apply
{
  filter: {
    directory_id: 5,
    hasTags: false,
    file_name_pattern: "*.mp4"
  },
  actions: {
    add_creator_ids: [1, 2],
    add_tag_ids: [3, 4],
    add_studio_ids: [5]
  }
}
```

**Features**:

- Directory bulk editor
- Filter-based bulk operations
- Preview before applying
- Count of affected videos

### 1.3 Creator/Studio Autocomplete & Quick-Create

**Endpoints**:

```
GET  /api/creators/autocomplete?q=jan    // Type-ahead search
GET  /api/creators/recent                // Last 10 created
POST /api/creators/quick-create          // 2-field creation
GET  /api/studios/autocomplete?q=        // Type-ahead search
GET  /api/studios/recent                 // Last 10 created
POST /api/studios/quick-create           // 2-field creation
```

**Features**:

- Type-ahead with profile picture display
- Recent entities dropdown
- Quick-create modal (name + optional description)
- No page reload required

---

## Phase 2: Filename & Directory Pattern Automation

**Timeline**: 2-3 weeks  
**Goal**: Automate tagging of new videos during indexing

### 2.1 Configurable Path Parser

**New Utility**: `src/utils/path-parser.ts`

```typescript
interface PathParseConfig {
  patterns: Array<{
    pattern: string; // Regex or glob
    creatorGroup?: number; // Capture group for creator
    studioGroup?: number; // Capture group for studio
    tagGroups?: number[]; // Capture groups for tags
  }>;
}

function parseVideoPath(
  filePath: string,
  config: PathParseConfig,
): {
  creator: string | null;
  studio: string | null;
  tags: string[];
  confidence: "high" | "medium" | "low";
};
```

**Example Patterns**:

```typescript
patterns: [
  "/videos/(?<creator>[^/]+)/*", // High confidence
  "(?i)onlyfans.*(?<creator>[a-z0-9_]+)_", // Medium confidence
  "/videos/(?<studio>[^/]+)/(?<creator>[^/]+)/*", // High confidence
];
```

### 2.2 Tagging Rules Engine

**New Tables**:

```sql
CREATE TABLE tagging_rules (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  rule_type TEXT NOT NULL,      -- 'path_match', 'metadata_match', 'manual'
  is_enabled BOOLEAN DEFAULT 1,
  priority INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE tagging_rule_conditions (
  id INTEGER PRIMARY KEY,
  rule_id INTEGER NOT NULL,
  condition_type TEXT NOT NULL,  -- 'path_pattern', 'file_pattern', 'duration_range', 'resolution'
  operator TEXT NOT NULL,        -- 'matches', 'equals', 'gt', 'lt'
  value TEXT NOT NULL
);

CREATE TABLE tagging_rule_actions (
  id INTEGER PRIMARY KEY,
  rule_id INTEGER NOT NULL,
  action_type TEXT NOT NULL,     -- 'add_creator', 'add_tag', 'add_studio'
  target_id INTEGER NOT NULL,    -- Entity ID or special value
  dynamic_value TEXT             -- For capture group references
);
```

**Endpoints**:

```
POST /api/tagging-rules              // Create rule
GET  /api/tagging-rules              // List rules
PATCH /api/tagging-rules/:id         // Update rule
DELETE /api/tagging-rules/:id        // Delete rule
POST /api/tagging-rules/:id/test     // Test against videos
POST /api/tagging-rules/apply        // Apply to all videos
```

**Example Rule**:

```json
{
  "name": "OnlyFans Videos in Creator Folders",
  "conditions": [
    { "type": "path_pattern", "value": "/OnlyFans/(?<creator>[^/]+)/*" }
  ],
  "actions": [
    { "type": "add_tag", "tag_id": 1 },
    { "type": "add_creator", "dynamic": "capture_group", "group": "creator" }
  ]
}
```

### 2.3 Auto-Tag Hook During Video Scanning

**Modify**: `src/modules/directories/watcher.service.ts`

```typescript
if (this.newVideoIds.length > 0) {
  // Existing
  await this.processStoryboardQueue();

  // NEW: Auto-apply tagging rules
  await autoTaggingService.applyRulesToVideos(this.newVideoIds);
}
```

**New Service**: `src/modules/auto-tagging/auto-tagging.service.ts`

---

## Phase 3: AI-Powered Face Recognition

**Timeline**: 3-4 weeks  
**Goal**: Automatically identify creators from video content

### 3.1 Technology Selection

**Recommendation**: `@vladmandic/face-api`

- Pure JavaScript (Bun-compatible)
- Good accuracy for thumbnail-sized images
- No external services required
- 128-dimensional face embeddings

### 3.2 Face Detection Service

**New Module**: `src/modules/face-recognition/`

**Features**:

- Extract faces from video frames
- Compute face descriptors (embeddings)
- Match against known creator faces
- Train creator models from tagged videos

**New Tables**:

```sql
CREATE TABLE creator_face_models (
  id INTEGER PRIMARY KEY,
  creator_id INTEGER NOT NULL UNIQUE,
  face_descriptor TEXT NOT NULL,  -- JSON array
  face_count INTEGER DEFAULT 0,
  trained_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE video_faces (
  id INTEGER PRIMARY KEY,
  video_id INTEGER NOT NULL,
  frame_timestamp REAL NOT NULL,
  face_descriptor TEXT NOT NULL,
  matched_creator_id INTEGER,
  confidence REAL
);
```

### 3.3 Face Clustering for Unknown Videos

**Workflow**:

1. Extract faces from all untagged videos
2. Compute similarity matrix
3. Cluster using DBSCAN
4. Suggest: "These 47 videos might be the same creator"

**Endpoint**:

```
POST /api/face-recognition/cluster-untagged
```

### 3.4 Auto-Tag After Creator Assignment

**Workflow**:

1. User assigns creator to a video
2. Train/update creator face model
3. Find untagged videos with matching faces
4. Auto-assign (confidence > 0.7)
5. Notify user of auto-assigned videos

---

## Phase 4: Platform Integration

**Timeline**: 2-3 weeks  
**Goal**: Link videos to platform profiles

### 4.1 Platform Username Pattern Matching

**Patterns**:

```typescript
const platformPatterns = {
  onlyfans: {
    pattern: /(?:OF|onlyfans)[\s_-]*(?<username>[a-z0-9_.]+)/i,
    base_url: "https://onlyfans.com/",
  },
  fansly: {
    pattern: /(?:FS|fansly)[\s_-]*(?<username>[a-z0-9_.]+)/i,
    base_url: "https://fansly.com/",
  },
};
```

### 4.2 Profile Management Tool

**Approach**: User-provided profile URLs (no scraping)

**Endpoints**:

```
POST /api/platforms/bulk-lookup     // Check if profile exists (read-only)
POST /api/creators/link-profile     // Link platform profile to creator
GET  /api/platforms/search          // Search platform profiles
```

**Features**:

- User enters profile URL
- System extracts username/ID
- Creates/updates creator_platforms record
- Downloads profile picture if available

### 4.3 Auto-Extract Profile Pictures

**Workflow**:

- When creator is created or first video assigned
- Extract frame at 20% duration
- Detect face and crop
- Save as profile picture

---

## Phase 5: Advanced Workflow Features

**Timeline**: 1-2 weeks  
**Goal**: Data quality and monitoring

### 5.1 Duplicate Detection & Merge

**Algorithm**:

- Exact duplicates: file hash match
- Visual duplicates: face similarity
- Metadata duplicates: duration + resolution within 5%

**Endpoints**:

```
GET  /api/videos/duplicates         // Find duplicates
POST /api/videos/merge              // Merge two videos
```

### 5.2 Smart Suggestions Engine

**Features**:

- "You usually tag videos from /OnlyFans with tag 'exclusive'"
- "Videos from this creator are also tagged 'hd'"
- "These 15 videos: same duration + creator = same series"

### 5.3 Triage Statistics Dashboard

**Endpoint**:

```
GET /api/triage/stats
{
  total_untagged: 2147,
  untagged_this_week: 47,
  avg_tagging_time_per_video: 45,
  top_creators_added_this_week: [{name, count}],
  directories_with_most_untagged: [{path, count}]
}
```

---

## Implementation Timeline

| Phase       | Priority    | Duration  | Backlog Impact |
| ----------- | ----------- | --------- | -------------- |
| **Phase 1** | 🔴 Critical | 2-3 weeks | High           |
| **Phase 2** | 🟡 High     | 2-3 weeks | High           |
| **Phase 3** | 🟢 Medium   | 3-4 weeks | High           |
| **Phase 4** | 🟢 Low      | 2-3 weeks | Medium         |
| **Phase 5** | 🟢 Low      | 1-2 weeks | Low            |

**Total Estimated Time**: 10-15 weeks

---

## Quick Win: Analyze Existing Videos

Run this script to identify patterns in existing videos:

```bash
bun run scripts/analyze-existing-videos.ts
```

**Output**:

```
Top 20 Directories (potential creators):
  creator_1: 47 videos
  creator_2: 32 videos
  ...

Top 20 Filename Prefixes (potential series):
  episode_1*: 15 videos
  scene_02*: 12 videos
```

Use this data to prioritize bulk tagging operations.

---

## File Structure

```
src/
├── modules/
│   ├── auto-tagging/           # NEW: Phase 2
│   │   ├── auto-tagging.service.ts
│   │   ├── auto-tagging.types.ts
│   │   └── auto-tagging.routes.ts
│   ├── face-recognition/       # NEW: Phase 3
│   │   ├── face-recognition.service.ts
│   │   ├── face-recognition.types.ts
│   │   └── face-recognition.routes.ts
│   ├── platform-management/    # NEW: Phase 4
│   │   ├── platform-management.service.ts
│   │   ├── platform-management.types.ts
│   │   └── platform-management.routes.ts
│   ├── triage/
│   │   └── triage.service.ts   # MODIFY: Add quick actions
│   └── videos/
│       └── videos.service.ts   # MODIFY: Add bulk conditional apply
├── utils/
│   └── path-parser.ts          # NEW: Phase 2
└── database/
    └── migrations/
        └── 0XX_tagging_rules.sql       # NEW: Phase 2
        └── 0XX_face_recognition.sql    # NEW: Phase 3
```

---

## API Endpoints Summary

### New Endpoints (Phase 1)

```
POST /api/videos/triage/bulk-actions
GET  /api/videos/triage/statistics
GET  /api/creators/autocomplete?q=
GET  /api/creators/recent
POST /api/creators/quick-create
GET  /api/studios/autocomplete?q=
GET  /api/studios/recent
POST /api/studios/quick-create
POST /api/videos/bulk/conditional-apply
```

### New Endpoints (Phase 2)

```
POST /api/tagging-rules
GET  /api/tagging-rules
PATCH /api/tagging-rules/:id
DELETE /api/tagging-rules/:id
POST /api/tagging-rules/:id/test
POST /api/tagging-rules/apply
```

### New Endpoints (Phase 3)

```
POST /api/face-recognition/detect
POST /api/face-recognition/match
POST /api/face-recognition/train
POST /api/face-recognition/cluster-untagged
POST /api/face-recognition/auto-tag
```

### New Endpoints (Phase 4)

```
POST /api/platforms/lookup
POST /api/creators/link-profile
GET  /api/platforms/search
```

### New Endpoints (Phase 5)

```
GET  /api/videos/duplicates
POST /api/videos/merge
GET  /api/triage/suggestions
GET  /api/triage/stats
```

---

## Backlog Clearance Projections

**Without Automation**: 2000 videos × 2 min = **67 hours**

| Phase       | Time per Video | Total Time | Hours Saved |
| ----------- | -------------- | ---------- | ----------- |
| Baseline    | 2 min          | 67 hours   | -           |
| Phase 1     | 0.5 min        | 17 hours   | 50 hours    |
| Phase 1+2   | 0.2 min        | 7 hours    | 60 hours    |
| Phase 1+2+3 | 0.05 min       | 2 hours    | 65 hours    |

---

## Next Steps

1. **Start Phase 1**: Implement enhanced triage and bulk operations
2. **Test with real data**: Run on subset of 2000 videos
3. **Iterate**: Adjust based on user feedback
4. **Phase 2**: Add automation hooks and pattern matching
5. **Phase 3**: Implement face recognition for bulk auto-tagging

---

## Notes

- All endpoints require authentication (session cookie)
- Profile pictures stored in `env.PROFILE_PICTURES_DIR`
- Face descriptors stored as JSON in database
- Rate limiting applies to all external requests
- No automated scraping - user-provided URLs only
