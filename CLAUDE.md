# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Single-user video streaming backend built with Bun, Fastify, and SQLite. Manages local video files with comprehensive features:

- **Video Management**: Automatic indexing, metadata extraction, search/filter
- **Organization**: Hierarchical tags, creators, playlists, favorites, bookmarks
- **Media Features**: HTTP range streaming, thumbnail generation, GPU-accelerated conversion
- **Automation**: Scheduled directory scanning, real-time WebSocket updates
- **Data Management**: Ratings (1-5 stars), custom metadata, database backup/export

Uses session-based authentication and serves content via HTTP range requests for efficient streaming.

## Commands

### Development

```bash
# Start development server with auto-reload
bun dev

# Start production server
bun start
```

### Testing

```bash
# Run all tests
bun test

# Run specific test file
bun test tests/integration/auth.test.ts

# Run tests matching a pattern
bun test --filter "should register"
```

### Database

```bash
# Generate and run Drizzle migrations
bun db:generate
bun db:migrate
```

### Conversions

```bash
# List available presets
curl http://localhost:3000/api/presets

# Start conversion (requires authentication)
curl -X POST http://localhost:3000/api/videos/1/convert \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{"preset": "1080p_h265"}'

# Monitor conversion status
curl http://localhost:3000/api/conversions/1 -b cookies.txt

# Download converted video
curl http://localhost:3000/api/conversions/1/download -b cookies.txt -o output.mkv
```

## Architecture

### Database Layer (Bun's Built-in SQLite)

**Critical Pattern**: Services MUST use a getter instead of caching the database reference:

```typescript
// ✅ Correct
export class MyService {
  private get db() {
    return getDatabase();
  }
}

// ❌ Wrong - will break test isolation
export class MyService {
  private db = getDatabase();
}
```

**Why**: Tests close and reopen the database between suites. Cached references become stale and throw "Cannot use a closed database" errors.

The database connection manager (`src/config/database.ts`) validates the connection on every `getDatabase()` call by running a test query. If the database is closed, it reinitializes.

### Module Structure

Each feature module follows this pattern:

- `*.types.ts` - TypeScript interfaces and types
- `*.service.ts` - Business logic (uses database getter pattern)
- `*.routes.ts` - Fastify route definitions
- `*.schemas.ts` - Zod validation schemas (if needed)

Services are instantiated as singletons and exported at the bottom of the service file.

### Error Handling

**Critical**: The global error handler MUST be registered in `src/server.ts` BEFORE routes are registered. Fastify requires this order.

All custom errors extend `AppError` and include `Object.setPrototypeOf()` calls to ensure `instanceof` checks work:

```typescript
export class MyCustomError extends AppError {
  constructor(message = "Default message") {
    super(statusCode, message);
    Object.setPrototypeOf(this, MyCustomError.prototype); // Required!
  }
}
```

Error responses follow this format:

```json
{
  "success": false,
  "error": {
    "message": "Error description",
    "statusCode": 400
  }
}
```

### Session-Based Authentication

- Uses bcrypt for password hashing (12 rounds)
- Single-user system - registration is disabled after first user
- Sessions stored in SQLite with UUIDs
- Cookies are httpOnly and use the secret from `SESSION_SECRET` env var
- Session expiration configured via `SESSION_EXPIRY_HOURS`

**Authentication Middleware**: `src/modules/auth/auth.middleware.ts`

- `authenticateUser` - Throws 401 if not authenticated
- `optionalAuth` - Sets `request.user` if authenticated, continues otherwise

### Video Metadata Extraction

Uses `fluent-ffmpeg` with FFprobe to extract:

- Duration, resolution (width/height)
- Video/audio codecs
- Bitrate, FPS

Extraction happens asynchronously during directory scanning. Failed extractions are logged but don't block indexing.

### Directory Scanning

**Two-phase approach**:

1. Immediate scan when directory is registered
2. Optional scheduled scans via `node-cron` (not yet implemented)

**Flow**:

1. `DirectoriesService.create()` validates path and creates DB record
2. `WatcherService.scanDirectory()` recursively finds video files
3. For each video: compute XXH3-128 hash with collision detection, extract metadata, create DB record
4. Results logged to `scan_logs` table

**Soft Deletion**: When files are missing, they're marked `is_available = 0` instead of deleted from the database.

### Hierarchical Tags

Uses adjacency list model with `parent_id` self-reference. Tag queries use recursive CTEs for tree traversal.

### GPU-Accelerated Video Conversion

**Architecture**:

- Job queue system processes one conversion at a time
- Uses VAAPI (Video Acceleration API) for GPU encoding
- Progress tracking via FFmpeg output parsing
- Real-time WebSocket updates for conversion status

**Presets** (`src/config/presets.ts`):

- 9 presets covering 1080p, 720p, and original resolution
- Three codecs: H.264 (compatibility), H.265/HEVC (balance), AV1 (best compression)
- All outputs use MKV container, preserving aspect ratio
- Quality parameters (QP) tuned for file size optimization

**Conversion Flow**:

1. User submits conversion via `POST /api/videos/:id/convert`
2. Job created with status `pending`
3. Queue processes job, updating status to `processing`
4. FFmpeg spawned with VAAPI encoding
5. Progress broadcast via WebSocket (`conversion:progress` events)
6. Completion updates status to `completed` and stores output file path
7. User can download via `GET /api/conversions/:id/download`

**WebSocket Events**:

- `conversion:started` - Job begins processing
- `conversion:progress` - Real-time progress percentage
- `conversion:completed` - Job finished successfully
- `conversion:failed` - Job encountered error

**Important Notes**:

- **CRITICAL**: Requires GPU with VAAPI support (Intel/AMD on Linux)
- Check VAAPI availability: `vainfo` command should show supported profiles
- Intel GPUs: Install `intel-media-driver` or `i965-va-driver`
- AMD GPUs: Install `mesa-va-drivers`
- Output files stored in `data/conversions/` directory
- Jobs can be cancelled while `pending` or `processing`
- Failed/completed jobs retain metadata for history
- Queue automatically starts on server initialization (except in tests)
- If VAAPI unavailable, conversions will fail - consider software encoding fallback

### WebSocket Communication

**Connection**: `ws://[host]:[port]/ws`

- Requires session cookie authentication
- Service registered at `src/modules/websocket/websocket.ts`
- Broadcasts conversion events to all connected clients
- Gracefully handles disconnects and reconnections

### Scheduled Directory Scanning

**Scheduler Service** (`src/modules/scheduler/scheduler.service.ts`):

- Uses `node-cron` for periodic scans
- Scans all directories with `auto_scan = true`
- Interval configurable per directory via `scan_interval_minutes`
- Automatically starts on server initialization (except in tests)
- Logs scan results to `scan_logs` table

## Testing

Tests use Bun's built-in test runner (`bun:test`). Integration tests in `tests/integration/` use Fastify's `.inject()` for HTTP simulation.

**Test Utilities** (`tests/helpers/test-utils.ts`):

- `setupTestServer()` - Creates and readies a Fastify instance
- `cleanupTestServer()` - Closes server and database
- `cleanupDatabase()` - Deletes all data in reverse dependency order
- `createTestUser()` - Registers and logs in a test user, returns session cookie

**Test Structure**:

```typescript
describe("Feature", () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = await setupTestServer();
  });

  afterAll(async () => {
    await cleanupTestServer(server);
  });

  beforeEach(() => {
    cleanupDatabase(); // Clean between tests
  });

  // Tests...
});
```

**Test Database**: Uses the same database path configured in `.env`. Tests assume they own the database during execution.

## Environment Configuration

Copy `.env.example` to `.env` and configure:

**Required**:

- `SESSION_SECRET` - Must be at least 32 characters (randomize for production)

**Important Defaults**:

- `DATABASE_PATH=./data/database.db` - SQLite database location
- `NODE_ENV=development` - Affects logging and error verbosity
- `SESSION_EXPIRY_HOURS=168` - 7 days

**FFmpeg Paths**: May need adjustment based on system:

- `FFMPEG_PATH=/usr/bin/ffmpeg`
- `FFPROBE_PATH=/usr/bin/ffprobe`

**Storage Paths**:

- `THUMBNAILS_DIR=./data/thumbnails` - Thumbnail storage
- `CONVERSIONS_DIR=./data/conversions` - Converted video storage
- `LOGS_DIR=./logs` - Application logs

**Thumbnail Settings**:

- `THUMBNAIL_SIZE=320x240` - Thumbnail dimensions (width x height)
- `THUMBNAIL_TIMESTAMP=5.0` - Fallback position in video (seconds, used when duration unavailable)
- `THUMBNAIL_FORMAT=webp` - Image format (webp or jpg)
- `THUMBNAIL_QUALITY=80` - Compression quality (1-100, higher is better)
- `THUMBNAIL_POSITION_PERCENT=20` - Default position as percentage of video duration (0-100)

**File Scanning**:

- `DEFAULT_SCAN_INTERVAL_MINUTES=30` - Default auto-scan interval
- `MAX_FILE_SIZE_GB=50` - Maximum video file size to index

Environment validation happens at startup via Zod schema in `src/config/env.ts`.

## Implementation Status

**Completed** (Phases 1-7):

- Project foundation with Bun + Fastify
- Authentication (register, login, logout, sessions)
- Directory management and registration
- Recursive video file scanning with scheduler
- Video metadata extraction with FFprobe
- Video CRUD operations with search and filtering
- File hash computation (XXH3-128 with collision detection)
- HTTP range request video streaming
- Creators management with many-to-many video relationships
- Hierarchical tags system with parent/child relationships
- Rating system (1-5 stars with comments)
- Thumbnail generation with FFmpeg (WebP format, percentage-based frame selection, auto-generation)
- Playlists with position ordering
- Favorites system
- Bookmarks with timestamps and descriptions
- Database backup and export functionality
- GPU-accelerated video conversion with presets (H.264/H.265/AV1)
- Real-time WebSocket updates for conversion progress
- Job queue management for conversions
- Scheduled directory scanning with node-cron
- Full Swagger UI API documentation

## Key Patterns

### Validation

Use Zod schemas and the `validateSchema()` helper from `src/utils/validation.ts`:

```typescript
import { validateSchema } from "@/utils/validation";
import { mySchema } from "./my.schemas";

const validated = validateSchema(mySchema, data);
```

### Logging

Use the Pino logger from `src/utils/logger.ts`:

```typescript
import { logger } from "@/utils/logger";

logger.info({ videoId, filePath }, "Video indexed");
logger.error({ error }, "Failed to extract metadata");
```

### File Utilities

Common file operations in `src/utils/file-utils.ts`:

- `isVideoFile(path)` - Check if file is a supported video format
- `getFileSize(path)` - Get file size in bytes
- `computeFileHash(path)` - Compute XXH3 hash (128-bit partial for files >= 10MB, 64-bit full for smaller files)
- `computeFullHash(path)` - Compute full XXH3-64 streaming hash (used for collision resolution)

**Hash Implementation**:

- Uses XXH3 (xxHash3) via `@node-rs/xxhash` for extremely fast hashing
- Files < 10MB: full XXH3-64 streaming hash (~5ms)
- Files >= 10MB: partial XXH3-128 hash sampling 4MB start + 4MB middle + 4MB end + file size (~5-10ms)
- **Collision detection**: automatic fallback to full XXH3-64 streaming hash when partial hash collision detected
  - Uses 64-bit for full hash (vs 128-bit for partial) due to library streaming limitations
  - Safe: probability of 64-bit collision AFTER 128-bit partial collision is negligible
  - Enables true streaming with no memory limits (critical for files >4GB)
- ~50-100x faster than SHA256 while maintaining sufficient uniqueness for duplicate detection

## Module-Specific Patterns

### Playlists

- Videos are ordered by `position` integer field
- Adding video without position auto-assigns to end (MAX(position) + 1)
- Position conflicts can occur during reordering - handle via transaction-like updates
- `GET /api/playlists/:id/videos` returns videos with `thumbnail_url` field populated from LEFT JOIN with thumbnails table

### Thumbnails

- **One thumbnail per video** (UNIQUE constraint on `video_id`)
- **Auto-generated** during directory scan if missing
- **Format**: WebP by default (configurable: webp or jpg) for 30-40% storage savings
- **Frame selection**: Percentage-based (default 20% of video duration) for better content representation
  - Scales with video length (20% of 10s = 2s, 20% of 2hr = 24min)
  - Avoids intros and credits
  - Fallback to fixed timestamp if duration unavailable
- **Quality control**: Configurable compression (1-100 scale, default 80)
- **API options**:
  - `timestamp`: Override with specific second (e.g., 30.5)
  - `positionPercent`: Override with percentage (e.g., 50 for midpoint)
- **Serving**: `/api/thumbnails/:id/image` with dynamic content-type (image/webp or image/jpeg)
- **Storage**: `file_size_bytes` populated, dimensions parsed from `THUMBNAIL_SIZE` env

### Conversions

- Jobs are queued and processed sequentially (one at a time)
- FFmpeg progress parsed from stderr output (timemarks converted to percentage)
- Cancellation sends SIGTERM to FFmpeg process
- Output files follow pattern: `{video_id}_{preset}_{timestamp}.mkv`
- WebSocket broadcasts require active connection - missed updates not queued

### Backup

- Exports database and optionally includes video files
- Uses streaming for large file exports
- Database export via `.backup()` SQLite command
- Video files copied to temporary archive then streamed as ZIP

## Database Schema Highlights

- **Single-user constraint**: Registration checks user count and rejects if > 0
- **Foreign keys enabled**: `PRAGMA foreign_keys = ON`
- **WAL mode**: Better concurrency for SQLite
- **Soft deletes**: Videos have `is_available` flag for missing files
- **Many-to-many relationships**:
  - `video_creators` (videos ↔ creators)
  - `video_tags` (videos ↔ tags)
  - `playlist_videos` (playlists ↔ videos with position)
- **One-to-one relationships**:
  - `thumbnails` (video_id UNIQUE - one thumbnail per video)
- **New tables for Phase 4-7**:
  - `conversions` - Video conversion jobs with status, progress, and output paths
  - `ratings` - Video ratings with 1-5 stars and optional comments
  - `bookmarks` - Timestamp bookmarks within videos
  - `favorites` - User-favorited videos
  - `video_metadata` - Custom key-value metadata per video

See `src/database/schema.sql` for complete schema.

## API Endpoints Summary

All endpoints are prefixed with `/api`. Full documentation available at `/docs` (Swagger UI).

**Authentication**: `/auth/*`

- Register (once only), login, logout, get current user

**Videos**: `/videos/*`

- CRUD operations, streaming, verification, search/filter
- `/videos/:id/stream` - HTTP range request streaming
- `/videos/:id/convert` - Start conversion job
- `/videos/:id/conversions` - List conversions for video
- `/videos/:id/thumbnails` - Generate/get thumbnails

**Directories**: `/directories/*`

- Register, update, delete, scan, statistics

**Creators**: `/creators/*`

- CRUD operations, list videos by creator

**Tags**: `/tags/*`

- CRUD operations with parent/child support, list videos by tag

**Ratings**: `/ratings/*`

- CRUD operations, list ratings by video

**Thumbnails**: `/thumbnails/*`

- Generate (auto or manual), serve image, delete
- `/thumbnails/:id/image` - Serve thumbnail (WebP or JPEG, dynamic content-type)
- Generation parameters: `timestamp` (seconds) or `positionPercent` (0-100)

**Playlists**: `/playlists/*`

- CRUD operations, add/remove videos, reorder
- `/playlists/:id/videos` - Get videos in playlist (includes thumbnail URLs)

**Favorites**: `/favorites/*`

- Add/remove favorites, list user favorites

**Bookmarks**: `/bookmarks/*`

- CRUD operations, list bookmarks by video

**Conversions**: `/conversions/*`

- Get job status, cancel, delete, download result
- `/conversions/:id/download` - Download converted video
- `/presets` - List available conversion presets

**Backup**: `/backup/*`

- Export database and optionally video files as ZIP

**WebSocket**: `/ws`

- Real-time conversion progress updates
