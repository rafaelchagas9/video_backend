# Performance Optimization Report

**Project:** Video Streaming Backend
**Date:** 2026-05-24
**Scope:** Full codebase audit across 70+ source files

---

## CRITICAL PRIORITY

### 1. Dual Database Connection Pools

- [x] **Implemented**

**Location:** `src/config/database.ts` (pg Pool) + `src/config/drizzle.ts` (postgres.js)

The `pg` Pool in `database.ts` is instantiated at server startup via `getDatabase()` in `server.ts:97`, but Drizzle uses a completely separate `postgres` client pool in `drizzle.ts:8-11`. **Every database operation therefore opens connections from two independent pools**, doubling concurrent connections to PostgreSQL.

**Fix:** Remove the `pg` Pool dependency entirely. Only `postgres.js` + Drizzle is used throughout the codebase. The `database.ts` file and its `getDatabase()`, `query()`, `transaction()`, `queryOne()`, `queryAll()` functions are unused dead code.

---

### 2. N+1 Favorite Check on Video List

- [x] **Implemented**

**Location:** `src/modules/videos/videos.search.service.ts:481-514`

For every video in a paginated list (default 20 per page), `checkIsFavorite()` is called individually.

This issues **N separate SQL queries** per page load. For a page of 20 videos, that's 20 extra round-trips.

**Fix:** Batch into a single query: `SELECT video_id FROM favorites WHERE user_id = $1 AND video_id = ANY($2)`

---

### 3. `findById()` Double-Query Pattern

- [x] **Implemented**

**Locations:** `src/modules/videos/videos.service.ts:173-191` (update), `:250-265` (verifyAvailability)

Every `update()` and `verifyAvailability()` calls `findById()` twice -- once at the start to confirm existence, and once at the end to return the updated result.

**Fix:** For `update`, use `returning()` on the update statement itself and avoid the second `findById`. For `verifyAvailability`, just run the update directly.

---

### 4. Missing Database Indexes

- [x] **Implemented** (B-tree indexes added to Drizzle schema; GIN trigram indexes in `migrations/013_missing_indexes.sql`. Run `bun db:generate && bun db:migrate`, then `bun src/database/apply-migration.ts 013_missing_indexes.sql`)

| Table | Column(s) | Used In | Impact |
|-------|-----------|---------|--------|
| `videos` | `(title, description, file_name)` | `ilike` text search | Sequential scan |
| `video_related_scores` | `(source_video_id, computed_at)` | Cache staleness | Table scan |
| `conversion_jobs` | `(video_id, preset, status)` | findExisting() | No composite index |
| `face_extraction_jobs` | `video_id` | Lookups | Missing entirely |
| `video_face_detections` | `video_id` | Lookups | Missing entirely |
| `edit_jobs` | `video_id` | Lookups | Missing entirely |
| `playlists` | `user_id` | User playlist listing | Sequential scan |
| `video_metadata` | `(video_id, key)` | Key lookups within a video | Suboptimal |
| `tags` | `name` | Tag search by name | Composite `(name, parent_id)` doesn't help name-only queries |

**Recommendation:** Add GIN/trigram index for text search, composite indexes for common filters.

---

### 5. Sequential Insert in Related Scores

- [x] **Implemented**

**Location:** `src/modules/videos/videos.related.service.ts:192-200`

Each related video score is inserted one-by-one in a loop instead of a single batch insert.

**Fix:** Use `db.insert().values(scored.map(...))` with a single round-trip.

---

### 6. Blocking Sync Filesystem Operations in Stats

- [x] **Implemented**

**Location:** `src/modules/stats/stats.storage.service.ts:22-47`

`getDirectorySize()` uses `readdirSync`, `statSync` blocking the event loop. Called on every stats snapshot and API request. Additionally, the 5 directory size calls (`thumbnails`, `storyboards`, `profile_pictures`, `converted`, `faces`) run sequentially instead of in parallel.

**Fix:** Use `fs.promises.readdir` + `fs.promises.stat` with `Promise.all` for all 5 directories.

---

### 7. Settings Service: ~28 Wasted Queries Per Watch Update

- [x] **Implemented**

**Location:** `src/modules/settings/settings.service.ts:15-25`

`ensureDefaults()` runs **6 INSERTs on every `getValue()` call**. Since `videoStatsService.recordWatch()` calls `getNumber()` 4 times per watch event, that's **~28 queries just for settings** -- on a WebSocket hot path that fires every few seconds. Combined with the stats queries, each `recordWatch()` generates approximately **35+ database queries**.

**Fix:** Add an in-memory cache. Load settings once at startup, invalidate only on `updateValues()`. Run `ensureDefaults()` once at startup, not on every read.

**Impact:** Eliminates thousands of queries per minute under active use. Single highest-impact fix.

---

### 8. `readFileSync` in Thumbnail Route Blocks Event Loop

- [x] **Implemented**

**Location:** `src/modules/thumbnails/thumbnails.routes.ts:103`

Synchronous file read in an HTTP handler. Under concurrent thumbnail requests, this **serializes all I/O** on the entire server. No `Cache-Control` headers are set (unlike storyboards which set `max-age=86400`).

**Fix:** Replace with `createReadStream()` piped to Fastify reply. Add `Cache-Control: public, max-age=86400` headers.

---

### 9. Synchronous File I/O in Storyboards

- [x] **Implemented**

**Location:** `src/modules/storyboards/storyboards.service.ts` (multiple lines)

`readFileSync` / `writeFileSync` / `unlinkSync` used throughout for sprite sheets that can be **50+ MB**. `getSpriteAsset()` (line ~904) loads entire sprite into memory as a Buffer. `execSync` in `getAvailableShm()` (line ~574) spawns a shell synchronously.

**Fix:** Replace all with `fs/promises` equivalents. Stream sprite sheets with `createReadStream()` instead of buffering.

---

## HIGH PRIORITY

### 10. N+1 in `bulkDelete()`

- [x] **Implemented**

**Location:** `src/modules/videos/videos.bulk.service.ts:23-41`

Loops over IDs calling `videosService.delete()` individually. Each delete fires `findById` + favorite check + individual thumbnail deletes + individual conversion deletes + video delete. Deleting 100 videos fires **600+ queries**.

**Fix:** Bulk `DELETE WHERE id IN (...)` with CASCADE handling related records.

---

### 11. N+1 in `getDuplicates()`

- [x] **Implemented**

**Location:** `src/modules/videos/videos.bulk.service.ts:222-253`

First query gets duplicate hashes, then loops over each hash with individual `SELECT` queries.

**Fix:** Fetch all videos with duplicate hashes in a single query using a subquery or window function.

---

### 12. Sequential Bulk Conversion Job Creation

- [x] **Implemented**

**Location:** `src/modules/conversion/conversion.routes.ts:91-122`

Creates conversion jobs in a `for` loop -- one at a time. For 50 videos: ~200 sequential DB+Redis ops. Also silently swallows errors with no logging.

**Fix:** `Promise.allSettled()` with a concurrency limiter, or batch INSERT.

---

### 13. Recursive N+1 in Tag Tree

- [x] **Implemented**

**Location:** `src/modules/tags/tags.service.ts:147-164`

`buildTreeWithDescendants()` calls `findById()` + children query per node + recurses. Exponential query count for deep tag trees.

**Fix:** Fetch all tags in one query and build the tree in memory. The `getTree()` method already does this correctly -- apply the same pattern to `buildTreeWithDescendants()`.

---

### 14. Face Recognition: 1 pgvector Query Per Detection

- [x] **Implemented**

**Location:** `src/modules/face-recognition/face-recognition.service.ts:357-512`

For each face detection in a video, runs a separate pgvector similarity search. 100 detections = 100 individual vector similarity queries. Also inserts pending detections individually.

**Fix:** Batch all detection embeddings and run a single query with `ANY()` or a temporary table. Batch INSERT pending detections.

---

### 15. Auto-Tagging: O(N*M) Queries With No Batching

- [x] **Implemented**

**Location:** `src/modules/auto-tagging/auto-tagging.service.ts:101-118`

Queries videos one-by-one instead of `WHERE id IN (...)`. For each rule action, does individual SELECT + conditional INSERT per video. 100 videos * 5 rules * 3 actions = ~4,500 queries.

**Fix:** Batch fetch videos. Batch INSERTs. Use `INSERT ... ON CONFLICT DO UPDATE RETURNING id` (upsert) for creator/studio name lookups. Cache tagging rules (they rarely change).

---

### 16. Triage: Individual INSERTs in `applyBulkActions()`

- [x] **Implemented**

**Location:** `src/modules/triage/triage.service.ts:179-319`

For each video * each creator/tag/studio to add, issues individual INSERT. 100 videos * 8 entity IDs = 800 queries. (The "remove" operations already correctly use `inArray()`.)

**Fix:** Multi-row INSERT or `UNNEST` pattern for add operations.

---

### 17. Playlists: N Queries for `reorderVideos()` and `bulkUpdateVideos()`

- [x] **Implemented**

**Location:** `src/modules/playlists/playlists.service.ts:259-269, 298-335`

`reorderVideos()` issues one UPDATE per position (50 videos = 50 queries). `bulkUpdateVideos()` loops for add (2N+1 queries) and remove (N queries).

**Fix:** Single query with `CASE WHEN id = ? THEN position ? ... END`. Batch INSERT with conflict handling for adds. `WHERE id IN (...)` for removes.

---

### 18. WebSocket: No Rate Limiting on `video:watch`

- [x] **Implemented**

**Location:** `src/modules/websocket/websocket.ts:108-131`

Each watch update triggers **35+ DB queries** (see settings issue #7). No throttle or buffer on the WebSocket message handler.

**Fix:** Buffer watch updates and flush to DB every N seconds. Add rate limiting to the `video:watch` message type.

---

### 19. Sequential Independent DB Queries Throughout Services

- [x] **Implemented**

**Location:** `src/modules/websocket/websocket.ts:108-131`

Each watch update triggers **35+ DB queries** (see settings issue #7). No throttle or buffer on the WebSocket message handler.

**Fix:** Buffer watch updates and flush to DB every N seconds. Add rate limiting to the `video:watch` message type.

---

### 19. Sequential Independent DB Queries Throughout Services

- [x] **Implemented**

Multiple services fire independent queries sequentially that could run in parallel:

| Location | Queries | Fix |
|----------|---------|-----|
| `videos.service.ts:125-149` | `findById()` includes (collection, creators, tags, studios) | `Promise.all()` |
| `stats.routes.ts:372-389` | 4 snapshot creations | `Promise.all()` |
| `stats.usage.service.ts:20-141` | 5 sequential SQL queries | `Promise.all()` or combine |
| `stats.content.service.ts:19-139` | 4 sequential SQL queries | `Promise.all()` |
| `stats.library.service.ts:20-126` | 3 sequential SQL queries | `Promise.all()` |
| `scheduler.service.ts:215-217` | Daily stats jobs | `Promise.all()` |

**Fix:** Wrap independent queries in `Promise.all()`.

---

### 20. N+1 in Video Delete: Thumbnails and Conversions

- [x] **Implemented**

**Location:** `src/modules/videos/videos.service.ts:197-245`

Each video delete loops over thumbnails and conversions individually. CASCADE on the FK handles thumbnail deletion automatically. The loop fires `3N + M` queries where N=thumbnails, M=conversions.

**Fix:** Delete conversion jobs with `WHERE video_id = ?`, rely on CASCADE for thumbnails. 2 queries total instead of 3N+M+2.

---

## MODERATE PRIORITY

### 21. No Response Compression

- [x] **Implemented**

Fastify has `@fastify/compress` plugin available. API responses with video lists, stats, and collections would benefit significantly.

---

### 22. Streaming Overhead

- [x] **Implemented**

**Location:** `src/modules/videos/streaming.service.ts:98`

Every stream request calls `videosService.findById()` doing a full query with joins + favorite check, just to get the file path. Add a lightweight lookup method.

---

### 23. Stats Queries Without Caching

- [ ] **Implemented**

**Location:** `src/modules/stats/stats.library.service.ts`

Library stats recalculate `COUNT(*)`, `SUM`, `AVG`, and GROUP BY on the entire videos table per request. Serve from latest snapshot instead.

---

### 24. Conversion Queue Concurrency

- [ ] **Implemented**

**Location:** `env.ts:107` -- `CONVERSION_MAX_CONCURRENT` defaults to 1

VAAPI on modern GPUs can handle multiple concurrent encode sessions. Increase to 2-3.

---

### 25. SSE Broadcast Overhead

- [ ] **Implemented**

**Location:** `src/modules/events/events.service.ts:73-82`

`broadcast()` iterates all clients synchronously per event. Minimal impact for single-user app but worth noting.

---

### 26. SSE Session Validation Queries DB Every 30s Per Client

- [ ] **Implemented**

**Location:** `src/modules/events/events.service.ts:40-44, 95-107`

Each SSE client triggers a DB query every 30 seconds for session validation. With N clients, that is N queries every 30 seconds.

**Fix:** Cache session validity with a short TTL.

---

### 27. `NOT IN (SELECT ...)` in Content Stats

- [ ] **Implemented**

**Location:** `src/modules/stats/stats.content.service.ts:21-28`

Each `NOT IN (SELECT ...)` performs a full table scan of both `videos` and the related table. Used for gap analysis (no tags, no creators, no ratings, etc.).

**Fix:** Use `NOT EXISTS` with correlated subquery or `LEFT JOIN ... IS NULL` for better performance.

---

### 28. `RANDOM()` Full Table Scan

- [ ] **Implemented**

**Location:** `src/modules/videos/videos.service.ts:155-168`

`ORDER BY RANDOM()` performs a full table scan to get a random video.

**Fix:** Use `TABLESAMPLE` or random offset approach.

---

### 29. Regex Recompiled on Every `parseVideoPath()` Call

- [ ] **Implemented**

**Location:** `src/utils/path-parser.ts:130, 275`

`new RegExp(patternConfig.pattern)` is called inside the loop for every invocation. For a file scanner processing thousands of videos, this recompiles 8 regex patterns per file.

**Fix:** Pre-compile `RegExp` objects at module load time in `DEFAULT_PATTERNS`.

---

### 30. No Pagination on Several List Endpoints

- [ ] **Implemented**

| Endpoint | Location | Issue |
|----------|----------|-------|
| `favorites.list()` | `src/modules/favorites/favorites.service.ts:47` | No limit/offset |
| `tags.getVideos()` | `src/modules/tags/tags.service.ts:378` | No limit/offset |
| `playlists.list()` | `src/modules/playlists/playlists.service.ts:45` | No limit/offset |
| `playlists.getVideos()` | `src/modules/playlists/playlists.service.ts:207` | No limit/offset |
| `creators.getRecent()` | `src/modules/creators/creators.service.ts` | No max cap on limit |
| `face_recognition.findVideosWithCreator()` | `src/modules/face-recognition/face-recognition.service.ts` | No pagination |
| `face_recognition.getVideoFaceDetections()` | `src/modules/face-recognition/face-recognition.service.ts` | No limit |

**Fix:** Add pagination schemas (limit/offset) to all unbounded list endpoints.

---

### 31. `readFileSync` in Creator Picture Route

- [ ] **Implemented**

**Location:** `src/modules/creators/creators.routes.ts:334`

Synchronous file read blocks event loop for profile picture serving.

**Fix:** Use `createReadStream()` piped to Fastify reply.

---

### 32. Conversion Processor Re-fetches Job Already in Payload

- [ ] **Implemented**

**Location:** `src/modules/conversion/conversion.processor.service.ts:32-89`

`processJob()` calls `findById(jobId)` for data already available in the queue payload, and calls full `videosService.findById()` (with thumbnail JOIN + favorite check) when only `filePath`, `fileName`, `width`, `height` are needed.

**Fix:** Use payload data directly for job fields. Add a lightweight video lookup method that selects only needed columns.

---

### 33. `SELECT *` on Queries Needing Few Columns

- [ ] **Implemented**

Several frequently-called queries select all columns when only a few are needed:

| Location | Needs | Selects |
|----------|-------|---------|
| `conversion.jobs.service.ts:84-98` (findExisting) | `id`, `status` | All columns incl. `ffmpegOutput` |
| `thumbnails.service.ts:29-34` (existence check) | `id` | All columns |
| `stats.storage.service.ts:177-186` (snapshots) | Subset | All incl. large `directory_breakdown` JSON |

**Fix:** Specify only needed columns in `.select({ id: ..., status: ... })`.

---

### 34. `update()` Triple-Query Pattern Across Services

- [ ] **Implemented**

The pattern of `findById()` (existence) + update + `findById()` (return) appears in multiple services:

| Service | Location |
|---------|----------|
| `directories.service.ts` | `:119-148` |
| `bookmarks.service.ts` | `:74-114` |
| `ratings.service.ts` | `update()` |
| `edits.service.ts` | `cancel()` |

**Fix:** Use `UPDATE ... RETURNING` to avoid the final re-fetch.

---

### 35. Creator List: Three Full-Table GROUP BY Subqueries Every Call

- [ ] **Implemented**

**Location:** `src/modules/creators/creators.service.ts:115-130`

Every `list()` call computes `video_count`, `platform_count`, and `social_link_count` via independent `GROUP BY` subqueries regardless of whether those counts are needed. The same 3-subquery pattern is copy-pasted across `list()`, `autocomplete()`, and `getRecent()`.

**Fix:** Add denormalized counter columns on the `creators` table (`video_count`, `platform_count`, `social_link_count`) maintained via triggers or application-level increments. Cache autocomplete results (creator names rarely change).

---

### 36. Video Collections: Inefficient Neighbor Lookup

- [ ] **Implemented**

**Location:** `src/modules/video-collections/video-collections.service.ts:509`

`getNeighborsByVideoId()` calls `getCollectionContextByVideoId()` + `listEntries()` (2 queries), then does a linear scan in JavaScript to find prev/next. `addEntry()` fires 6 queries for a single add.

**Fix:** Replace neighbor lookup with SQL `LAG()`/`LEAD()` window functions.

---

### 37. `computePartialHash()` Memory Pressure

- [ ] **Implemented**

**Location:** `src/utils/file-utils.ts:108-131`

Allocates 3 buffers of 4MB each (12MB) simultaneously, then `Buffer.concat()` creates another ~12MB buffer. Peak memory is ~24MB per concurrent hash.

**Fix:** Process samples sequentially with a streaming XXH3 update, reducing peak from 24MB to 4MB per file.

---

## LOW PRIORITY

### 38. No Application-Level Cache

- [ ] **Implemented**

No Redis caching for frequently accessed data like video details, creator/studio/tag lists.

---

### 39. File Scanning is Fully Sequential

- [ ] **Implemented**

**Location:** `src/modules/directories/watcher.service.ts`

Indexes files one at a time in a for loop. For 10K+ files, this takes hours. Add concurrent indexing with I/O semaphore.

---

### 40. Thumbnail Generation Without Backpressure

- [ ] **Implemented**

**Location:** `src/modules/directories/watcher.service.ts:564`

`thumbnailsService.generate()` is fire-and-forget. With thousands of new files, unlimited FFmpeg processes could spawn. Use a queue.

---

### 41. Missing Request Timeout

- [ ] **Implemented**

No global request timeout in Fastify config. Long-running requests hold connections indefinitely.

---

### 42. Redundant ffprobe Duration Check

- [ ] **Implemented**

**Location:** `src/modules/conversion/conversion.ffmpeg.service.ts:49-53`

Spawns `ffprobe` every conversion job. Duration is already stored in `videos.duration_seconds`.

---

### 43. Redundant Database Indexes

- [ ] **Implemented**

Several indexes duplicate constraints that already create implicit indexes:

| Table | Column(s) | Issue |
|-------|-----------|-------|
| `thumbnails` | `video_id` | UNIQUE already creates an index, `idx_thumbnails_video` is redundant |
| `storyboards` | `video_id` | UNIQUE already creates an index, `idx_storyboards_video` is redundant |
| `video_stats` | `(user_id, video_id)` | PK + separate UNIQUE on same columns |
| `face_extraction_jobs` | `video_id` | UNIQUE already creates an index |
| `face_images` | `detection_id` | UNIQUE already creates an index |
| `videos` | `is_available` | `idx_videos_is_available` + `idx_videos_availability` are identical |
| `triage_progress` | `(user_id, filter_key)` | Composite index + UNIQUE on same columns |

**Fix:** Drop redundant indexes to reduce write overhead and disk usage.

---

### 44. `console.log` / `console.error` Instead of Pino Logger

- [ ] **Implemented**

**Location:** `src/config/database.ts:34,36,40,113,126`

Uses `console.error` / `console.log` instead of Pino logger per project standards.

**Fix:** Replace with `logger` from `@/utils/logger`.

---

### 45. Frame Extraction: Unused `statAsync()` Call

- [ ] **Implemented**

**Location:** `src/modules/frame-extraction/frame-extraction.service.ts:382`

`collectFrameMetadata()` calls `statAsync()` on every extracted frame but **never uses the result**. Wasted I/O.

**Fix:** Remove the unused stat call.

---

### 46. `path-parser.ts` Convenience Wrappers Re-parse Path N Times

- [ ] **Implemented**

**Location:** `src/utils/path-parser.ts:242-265`

`extractCreatorFromPath()`, `extractStudioFromPath()`, `extractTagsFromPath()` each independently call `parseVideoPath()`. If a caller needs multiple extractions, the full parsing is repeated N times.

**Fix:** Provide a combined extraction method that parses once and returns all fields.

---

## Summary Table

| # | Issue | Severity | Effort | Category |
|---|-------|----------|--------|----------|
| 1 | Dual connection pools | CRITICAL | 5 min | Infrastructure |
| 2 | N+1 favorite checks | CRITICAL | 15 min | Database |
| 3 | Double findById queries | CRITICAL | 10 min | Database |
| 4 | Missing indexes | CRITICAL | 15 min | Database |
| 5 | Sequential score inserts | CRITICAL | 5 min | Database |
| 6 | Sync FS in stats | CRITICAL | 15 min | Performance |
| 7 | Settings service wasted queries | CRITICAL | 20 min | Database |
| 8 | readFileSync in thumbnail route | CRITICAL | 10 min | Performance |
| 9 | Sync file I/O in storyboards | CRITICAL | 20 min | Performance |
| 10 | N+1 in bulkDelete | HIGH | 15 min | Database |
| 11 | N+1 in getDuplicates | HIGH | 10 min | Database |
| 12 | Sequential bulk conversion creation | HIGH | 15 min | Database |
| 13 | Recursive N+1 in tag tree | HIGH | 20 min | Database |
| 14 | Face recognition N+1 pgvector queries | HIGH | 30 min | Database |
| 15 | Auto-tagging O(N*M) queries | HIGH | 30 min | Database |
| 16 | Triage individual INSERTs | HIGH | 15 min | Database |
| 17 | Playlist reorder/bulk N queries | HIGH | 15 min | Database |
| 18 | WebSocket no rate limiting on watch | HIGH | 15 min | Real-time |
| 19 | Sequential independent DB queries | HIGH | 30 min | Database |
| 20 | N+1 in video delete | HIGH | 10 min | Database |
| 21 | No response compression | MODERATE | 5 min | Network |
| 22 | Streaming overhead | MODERATE | 15 min | Streaming |
| 23 | Stats no cache | MODERATE | 30 min | Architecture |
| 24 | Queue concurrency=1 | MODERATE | 1 min | Config |
| 25 | SSE broadcast overhead | MODERATE | 10 min | Real-time |
| 26 | SSE session validation every 30s | MODERATE | 15 min | Real-time |
| 27 | NOT IN subqueries in content stats | MODERATE | 10 min | Database |
| 28 | RANDOM() full table scan | MODERATE | 5 min | Database |
| 29 | Regex recompiled per parseVideoPath | MODERATE | 10 min | Performance |
| 30 | No pagination on list endpoints | MODERATE | 30 min | API |
| 31 | readFileSync in creator picture | MODERATE | 5 min | Performance |
| 32 | Processor re-fetches job in payload | MODERATE | 10 min | Conversion |
| 33 | SELECT * on queries needing few cols | MODERATE | 15 min | Database |
| 34 | Update triple-query pattern | MODERATE | 20 min | Database |
| 35 | Creator list full-table subqueries | MODERATE | 20 min | Database |
| 36 | Inefficient collection neighbor lookup | MODERATE | 15 min | Database |
| 37 | Hash memory pressure | MODERATE | 10 min | Performance |
| 38 | No app cache layer | LOW | N/A | Architecture |
| 39 | Sequential file scanning | LOW | 1 hr | Scanning |
| 40 | Thumbnail backpressure | LOW | 30 min | Processing |
| 41 | No request timeout | LOW | 2 min | Config |
| 42 | Redundant ffprobe | LOW | 5 min | Conversion |
| 43 | Redundant database indexes | LOW | 10 min | Database |
| 44 | console.log instead of logger | LOW | 5 min | Code Quality |
| 45 | Unused statAsync in frame extraction | LOW | 2 min | Performance |
| 46 | Path parser re-parsing | LOW | 15 min | Performance |

---

**Recommended order of execution:** #7 -> #1 -> #2 -> #8 -> #20 -> #3 -> #4 -> #5 -> #6 -> #9 (highest impact for least effort first).

The settings cache (#7) alone eliminates thousands of queries per minute under active use. The `readFileSync` fixes (#8, #9, #31) prevent event loop starvation under concurrent load.
