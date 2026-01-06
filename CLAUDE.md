# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Single-user video streaming backend built with Bun, Fastify, and SQLite. Manages local video files with metadata extraction, directory watching, hierarchical tags, ratings, playlists, favorites, and bookmarks. Uses session-based authentication and serves videos via HTTP range requests.

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
# Run migrations (if migration script exists)
bun db:migrate
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
  constructor(message = 'Default message') {
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
3. For each video: compute SHA256 hash, extract metadata, create DB record
4. Results logged to `scan_logs` table

**Soft Deletion**: When files are missing, they're marked `is_available = 0` instead of deleted from the database.

### Hierarchical Tags

Uses adjacency list model with `parent_id` self-reference. Tag queries use recursive CTEs for tree traversal (not yet implemented in service layer).

## Testing

Tests use Bun's built-in test runner (`bun:test`). Integration tests in `tests/integration/` use Fastify's `.inject()` for HTTP simulation.

**Test Utilities** (`tests/helpers/test-utils.ts`):
- `setupTestServer()` - Creates and readies a Fastify instance
- `cleanupTestServer()` - Closes server and database
- `cleanupDatabase()` - Deletes all data in reverse dependency order
- `createTestUser()` - Registers and logs in a test user, returns session cookie

**Test Structure**:
```typescript
describe('Feature', () => {
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

Environment validation happens at startup via Zod schema in `src/config/env.ts`.

## Implementation Status

**Completed** (Phases 1-3):
- Project foundation with Bun + Fastify
- Authentication (register, login, logout, sessions)
- Directory management and registration
- Recursive video file scanning
- Video metadata extraction with FFprobe
- Video CRUD operations
- File hash computation (SHA256)
- Integration tests with UTF-8 filename support
- HTTP range request video streaming

**Pending** (Phases 4-7):
- Creators, tags, and custom metadata
- Rating system
- Thumbnail generation with FFmpeg
- Playlists, favorites, and bookmarks
- Scheduled directory scanning with node-cron
- API documentation via Swagger UI (plugin registered but routes not documented)

## Key Patterns

### Validation
Use Zod schemas and the `validateSchema()` helper from `src/utils/validation.ts`:

```typescript
import { validateSchema } from '@/utils/validation';
import { mySchema } from './my.schemas';

const validated = validateSchema(mySchema, data);
```

### Logging
Use the Pino logger from `src/utils/logger.ts`:

```typescript
import { logger } from '@/utils/logger';

logger.info({ videoId, filePath }, 'Video indexed');
logger.error({ error }, 'Failed to extract metadata');
```

### File Utilities
Common file operations in `src/utils/file-utils.ts`:
- `isVideoFile(path)` - Check if file is a supported video format
- `getFileSize(path)` - Get file size in bytes
- `computeFileHash(path)` - Compute SHA256 hash

## Database Schema Highlights

- **Single-user constraint**: Registration checks user count and rejects if > 0
- **Foreign keys enabled**: `PRAGMA foreign_keys = ON`
- **WAL mode**: Better concurrency for SQLite
- **Soft deletes**: Videos have `is_available` flag for missing files
- **Many-to-many relationships**:
  - `video_creators` (videos ↔ creators)
  - `video_tags` (videos ↔ tags)
  - `playlist_videos` (playlists ↔ videos with position)

See `src/database/schema.sql` for complete schema.
