# Plan: Unified Video Processing & Face Recognition Integration

## Problem Statement

The backend currently opens video files multiple times for different operations:
1. **Metadata extraction** (FFprobe)
2. **Thumbnail generation** (FFmpeg - 1 frame)
3. **Storyboard generation** (FFmpeg - multiple frames)
4. **Face extraction (NEW)** - would require another file read

For spinning disks, this is inefficient. We need to unify frame extraction into a single FFmpeg pass.

## Architecture Overview

```
WatcherService (video indexed)
        │
        ▼
FrameExtractionService (NEW - single FFmpeg pass)
        │
        ├──► Extract frames to /dev/shm (RAM)
        │
        ├──► ThumbnailsService (pick 1 frame, save)
        ├──► StoryboardsService (create sprite sheet + VTT)
        └──► FaceExtractionQueue (send frames to Python service)
                    │
                    ▼
            Python Face Service (port 8100)
                    │
                    ▼
            PostgreSQL + pgvector
            (store embeddings, find matches)
```

## Key Design Decisions

1. **New FrameExtractionService** (not extending storyboard) - clear separation of concerns
2. **Temp frames in /dev/shm** - RAM-based, fast cleanup, falls back to disk if needed
3. **Thumbnail from extracted frames** - picks closest frame to target position (max 2.5s deviation)
4. **Face detection queued async** - user doesn't wait; WebSocket notification when done
5. **Graceful degradation** - if Python service unavailable, mark job pending for retry

## Database Schema (pgvector)

### Table: `creator_face_embeddings`
Reference faces for known creators (for similarity matching).

| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL PK | |
| creator_id | INTEGER FK | References creators |
| embedding | vector(512) | Face embedding |
| source_type | TEXT | 'manual_upload', 'video_detection', 'profile_picture' |
| source_video_id | INTEGER FK | Optional source video |
| source_timestamp_seconds | REAL | Position in source video |
| det_score | REAL | Detection confidence |
| is_primary | BOOLEAN | Primary reference face |
| estimated_age | INTEGER | From InsightFace |
| estimated_gender | TEXT | 'M' or 'F' |

Index: HNSW on embedding for cosine similarity.

### Table: `video_face_detections`
Faces detected in videos with timestamps.

| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL PK | |
| video_id | INTEGER FK | References videos |
| embedding | vector(512) | Face embedding |
| timestamp_seconds | REAL | Position in video |
| frame_index | INTEGER | Storyboard frame index |
| bbox_* | REAL | Bounding box (x1, y1, x2, y2) |
| det_score | REAL | Detection confidence |
| matched_creator_id | INTEGER FK | Auto-matched creator |
| match_confidence | REAL | Similarity score (0-1) |
| match_status | TEXT | 'pending', 'confirmed', 'rejected', 'no_match' |

Index: HNSW on embedding, compound index on (video_id, timestamp_seconds).

### Table: `face_extraction_jobs`
Job tracking for face extraction queue.

| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL PK | |
| video_id | INTEGER FK UNIQUE | One job per video |
| status | TEXT | 'pending', 'processing', 'completed', 'failed', 'skipped' |
| total_frames | INTEGER | Total frames to process |
| processed_frames | INTEGER | Progress counter |
| faces_detected | INTEGER | Count of faces found |
| error_message | TEXT | Error details if failed |
| retry_count | INTEGER | Number of retries |

## Files to Create

### 1. Database Schema
- `src/database/schema/face-recognition.schema.ts` - Drizzle schema for new tables
- `src/database/migrations/XXXX_face_recognition.sql` - Migration with pgvector

### 2. Frame Extraction Service
- `src/modules/frame-extraction/frame-extraction.service.ts` - Unified orchestrator
- `src/modules/frame-extraction/frame-extraction.types.ts` - Types and interfaces
- `src/modules/frame-extraction/index.ts` - Exports

### 3. Face Recognition Module
- `src/modules/face-recognition/face-recognition.service.ts` - Main service
- `src/modules/face-recognition/face-recognition.client.ts` - HTTP client for Python service
- `src/modules/face-recognition/face-extraction-queue.service.ts` - Background queue
- `src/modules/face-recognition/face-recognition.routes.ts` - API endpoints
- `src/modules/face-recognition/face-recognition.schemas.ts` - Zod validation
- `src/modules/face-recognition/face-recognition.types.ts` - Types
- `src/modules/face-recognition/index.ts` - Exports

## Files to Modify

### 1. Watcher Service
- `src/modules/directories/watcher.service.ts`
  - Replace storyboard queue with frame extraction queue
  - Call `frameExtractionService.queueExtraction()` instead of `storyboardsService.queueGenerate()`

### 2. Storyboard Service
- `src/modules/storyboards/storyboards.service.ts`
  - Add method `assembleFromFrames(frames: ExtractedFrame[])` - creates sprite from existing frames
  - Keep existing `generate()` for backward compatibility / manual triggers

### 3. Thumbnail Service
- `src/modules/thumbnails/thumbnails.service.ts`
  - Add method `saveFromFrame(videoId: number, frame: ExtractedFrame)` - saves extracted frame as thumbnail

### 4. Environment Config
- `src/config/env.ts`
  - Add `FACE_SERVICE_URL` (default: "http://localhost:8100")
  - Add `FACE_SIMILARITY_THRESHOLD` (default: 0.65)
  - Add `FACE_AUTO_TAG_THRESHOLD` (default: 0.75)
  - Add `FRAME_EXTRACTION_TEMP_DIR` (default: "/dev/shm")

### 5. Database Index
- `src/database/schema/index.ts` - Export new face-recognition schema
- `src/database/index.ts` - Register new tables

### 6. Server Registration
- `src/server.ts` - Register face-recognition routes

## API Endpoints

### Creator Face Embeddings
```
POST   /api/creators/:id/face-embeddings          Upload reference face
POST   /api/creators/:id/face-embeddings/base64   Upload from base64
GET    /api/creators/:id/face-embeddings          List reference faces
PUT    /api/creators/:id/face-embeddings/:eid/primary  Set primary
DELETE /api/creators/:id/face-embeddings/:eid     Delete reference
```

### Video Face Detections
```
GET    /api/videos/:id/faces                      List detected faces
POST   /api/videos/:id/faces/extract              Trigger face extraction
PUT    /api/videos/:id/faces/:did/confirm         Confirm match
PUT    /api/videos/:id/faces/:did/reject          Reject match
```

### Face Search
```
GET    /api/creators/:id/videos-by-face           Videos containing creator
POST   /api/faces/search                          Search by uploaded face
GET    /api/faces/health                          Python service status
```

## Implementation Order

1. **Phase 1: Database**
   - Create schema file
   - Create migration (enable pgvector, create tables)
   - Run migration

2. **Phase 2: Face Recognition Client**
   - Create HTTP client for Python service
   - Implement health check
   - Implement detect endpoint

3. **Phase 3: Frame Extraction Service**
   - Extract FFmpeg logic from storyboard service
   - Output individual frames to temp dir
   - Implement temp cleanup

4. **Phase 4: Integrate Thumbnail & Storyboard**
   - Add `saveFromFrame()` to thumbnails service
   - Add `assembleFromFrames()` to storyboards service
   - Wire up in frame extraction service

5. **Phase 5: Face Extraction Queue**
   - Create queue service
   - Process frames, call Python service
   - Store embeddings with pgvector

6. **Phase 6: Similarity Matching**
   - Implement `findSimilarCreators()` with pgvector
   - Auto-tag videos above threshold
   - WebSocket notifications

7. **Phase 7: API Routes**
   - Create routes for all endpoints
   - Register in server

8. **Phase 8: Watcher Integration**
   - Replace storyboard queue calls
   - Test end-to-end with directory scan

## Verification

### Unit Tests
- Face recognition client: mock Python service responses
- Similarity matching: test pgvector queries

### Integration Tests
1. Start Python face service
2. Upload a test video
3. Trigger directory scan
4. Verify:
   - Thumbnail created
   - Storyboard created (sprite + VTT)
   - Face detections stored
   - Similarity matches found (if reference faces exist)

### Manual Testing
```bash
# 1. Check face service health
curl http://localhost:8100/health

# 2. Upload reference face for creator
curl -X POST http://localhost:3000/api/creators/1/face-embeddings \
  -F "file=@face.jpg" -b cookies.txt

# 3. Scan directory with new video
curl -X POST http://localhost:3000/api/directories/1/scan -b cookies.txt

# 4. Check video face detections
curl http://localhost:3000/api/videos/1/faces -b cookies.txt

# 5. Search videos by creator face
curl http://localhost:3000/api/creators/1/videos-by-face -b cookies.txt
```

## Environment Variables to Add

```bash
# Face Recognition
FACE_SERVICE_URL=http://localhost:8100
FACE_SIMILARITY_THRESHOLD=0.65
FACE_AUTO_TAG_THRESHOLD=0.75
FACE_DETECTION_BATCH_SIZE=10
FACE_DETECTION_RETRY_INTERVAL_MS=300000
FACE_DETECTION_MAX_RETRIES=3

# Frame Extraction
FRAME_EXTRACTION_TEMP_DIR=/dev/shm
FRAME_EXTRACTION_FORMAT=jpg
FRAME_EXTRACTION_QUALITY=90
```

## Migration for Existing Videos

After implementation:
1. Videos with storyboards: create pending face extraction jobs
2. Background scheduler processes in batches (10/hour off-peak)
3. Videos without storyboards: wait for manual trigger or re-scan
