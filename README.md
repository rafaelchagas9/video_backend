# Video Streaming Backend

A TypeScript/Bun backend application for managing and streaming local video files. Built with Fastify and SQLite, this single-user system provides video indexing, metadata management, and HTTP streaming with support for hierarchical organization, ratings, playlists, and bookmarks.

## Features

### Implemented ✅

**Authentication & Security**
- Session-based authentication with bcrypt password hashing
- Single-user system with registration lock after first user
- HTTP-only secure cookies with configurable expiration

**Video Management**
- Automatic video indexing from registered directories
- Recursive directory scanning with file detection
- Metadata extraction (duration, resolution, codecs, bitrate, fps) via FFprobe
- SHA256 file hashing for deduplication detection
- Soft-delete for missing files (availability tracking)
- UTF-8 filename support (tested with special characters)

**API Endpoints**
- Full CRUD operations for videos and directories
- Video listing with pagination, filtering, and sorting
- Search functionality across video metadata
- Directory statistics and manual scan triggers
- HTTP range request video streaming

**Testing**
- Comprehensive integration test suite
- Test utilities for server setup and database isolation
- Real video file testing (281MB test file with special characters)

### Planned 🚧

**Media Organization** (Phase 4)
- Creator management with many-to-many video associations
- Hierarchical tags with recursive queries (parent/child relationships)
- Custom metadata key-value storage per video
- Tag tree navigation and filtering

**Ratings & Thumbnails** (Phase 5)
- 1-5 star rating system with optional comments
- Automatic thumbnail generation at configurable timestamps
- Multiple thumbnail positions per video
- Average rating calculation

**User Experience** (Phase 6)
- Playlist creation with custom ordering
- Favorites/watchlist functionality
- Video bookmarks with timestamps (mark favorite moments, climaxes)
- Bookmark descriptions and categorization

**Advanced Features** (Phase 7)
- Scheduled directory scanning with node-cron
- Performance optimization (caching, query optimization)
- API documentation via Swagger UI
- Enhanced security hardening
- Database backup/export utilities

## Technology Stack

- **Runtime**: [Bun](https://bun.sh) - Fast JavaScript runtime with built-in SQLite
- **Framework**: [Fastify](https://fastify.dev) - High-performance web framework
- **Database**: SQLite3 (via Bun's native driver)
- **Authentication**: bcrypt + session-based cookies
- **Validation**: [Zod](https://zod.dev) - TypeScript-first schema validation
- **Logging**: [Pino](https://getpino.io) - Fast JSON logger
- **Video Processing**: [fluent-ffmpeg](https://github.com/fluent-ffmpeg/node-fluent-ffmpeg) - FFmpeg wrapper for metadata extraction
- **Testing**: Bun's built-in test runner

## Prerequisites

- [Bun](https://bun.sh) v1.0 or higher
- [FFmpeg](https://ffmpeg.org) and FFprobe installed on your system
- Linux, macOS, or WSL2 (Bun requirement)

## Installation

1. **Clone the repository**
```bash
git clone <repository-url>
cd conversor-video
```

2. **Install dependencies**
```bash
bun install
```

3. **Configure environment**
```bash
cp .env.example .env
# Edit .env and set SESSION_SECRET to a random 32+ character string
```

4. **Verify FFmpeg installation**
```bash
which ffmpeg
which ffprobe
# Update FFMPEG_PATH and FFPROBE_PATH in .env if needed
```

## Usage

### Development

Start the development server with auto-reload:
```bash
bun dev
```

The server will start at `http://localhost:3000` (configurable via `PORT` in `.env`).

### Production

```bash
bun start
```

### First-Time Setup

1. **Register the first user** (only works once):
```bash
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username": "admin", "password": "your-secure-password"}'
```

2. **Login to get session cookie**:
```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username": "admin", "password": "your-secure-password"}' \
  -c cookies.txt
```

3. **Register a directory to watch**:
```bash
curl -X POST http://localhost:3000/api/directories \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{
    "path": "/path/to/your/videos",
    "auto_scan": true,
    "scan_interval_minutes": 30
  }'
```

The system will automatically scan the directory and index all video files.

### API Documentation

Access the Swagger UI documentation at:
```
http://localhost:3000/docs
```

### Health Check

```bash
curl http://localhost:3000/health
```

## Testing

Run all tests:
```bash
bun test
```

Run specific test file:
```bash
bun test tests/integration/auth.test.ts
```

Run tests matching a pattern:
```bash
bun test --filter "should register"
```

## Project Structure

```
conversor-video/
├── src/
│   ├── index.ts                    # Application entry point
│   ├── server.ts                   # Fastify server setup and configuration
│   ├── config/
│   │   ├── database.ts             # SQLite connection and initialization
│   │   ├── env.ts                  # Environment variable validation (Zod)
│   │   └── constants.ts            # Application constants
│   ├── database/
│   │   └── schema.sql              # Complete database schema
│   ├── modules/
│   │   ├── auth/                   # Authentication and sessions
│   │   ├── directories/            # Directory registration and scanning
│   │   └── videos/                 # Video CRUD and metadata
│   └── utils/
│       ├── errors.ts               # Custom error classes
│       ├── validation.ts           # Zod validation helpers
│       ├── logger.ts               # Pino logger configuration
│       └── file-utils.ts           # File operations and video detection
├── tests/
│   ├── integration/                # Integration tests
│   ├── helpers/                    # Test utilities
│   └── videos/                     # Test video files
├── data/
│   ├── database.db                 # SQLite database (created on first run)
│   └── thumbnails/                 # Generated thumbnails (future)
└── logs/                           # Application logs
```

## Database Schema

### Core Tables
- **users** - Single user with bcrypt-hashed password
- **sessions** - Active sessions with UUID and expiration
- **watched_directories** - Registered video directories with scan settings
- **videos** - Video files with metadata and availability status

### Metadata Tables (Planned)
- **creators** - Video creators/artists
- **video_creators** - Many-to-many relationship
- **tags** - Hierarchical tags with parent/child support
- **video_tags** - Many-to-many relationship
- **ratings** - User ratings with optional comments
- **video_metadata** - Custom key-value pairs per video

### User Experience Tables (Planned)
- **playlists** - Custom playlists with ordering
- **playlist_videos** - Videos in playlists with positions
- **favorites** - Favorited videos
- **bookmarks** - Timestamp bookmarks within videos

### Operational Tables
- **scan_logs** - Directory scan history and results

## Environment Variables

Required variables in `.env`:

```bash
# Server Configuration
PORT=3000                           # Server port
HOST=localhost                      # Server host
NODE_ENV=development                # development | production | test

# Database
DATABASE_PATH=./data/database.db    # SQLite database file path

# Paths
THUMBNAILS_DIR=./data/thumbnails    # Thumbnail storage
LOGS_DIR=./logs                     # Log file directory

# Authentication (REQUIRED - generate a secure random string!)
SESSION_SECRET=your-32-char-minimum-secret-here
SESSION_EXPIRY_HOURS=168            # 7 days

# Video Processing
FFMPEG_PATH=/usr/bin/ffmpeg         # FFmpeg binary path
FFPROBE_PATH=/usr/bin/ffprobe       # FFprobe binary path
THUMBNAIL_SIZE=320x240              # Default thumbnail dimensions
THUMBNAIL_TIMESTAMP=5.0             # Default thumbnail position (seconds)

# File Scanning
DEFAULT_SCAN_INTERVAL_MINUTES=30    # Auto-scan interval
MAX_FILE_SIZE_GB=50                 # Maximum video file size to index
```

## API Overview

### Authentication
- `POST /api/auth/register` - Create first user (disabled after)
- `POST /api/auth/login` - Login and receive session cookie
- `POST /api/auth/logout` - Invalidate current session
- `GET /api/auth/me` - Get current user information

### Directories
- `POST /api/directories` - Register directory for scanning
- `GET /api/directories` - List all registered directories
- `GET /api/directories/:id` - Get directory details
- `PATCH /api/directories/:id` - Update scan settings
- `DELETE /api/directories/:id` - Remove directory
- `POST /api/directories/:id/scan` - Trigger manual scan
- `GET /api/directories/:id/stats` - Get directory statistics

### Videos
- `GET /api/videos` - List videos (pagination, filtering, search)
- `GET /api/videos/:id` - Get video details
- `PATCH /api/videos/:id` - Update video metadata
- `DELETE /api/videos/:id` - Remove video from database
- `GET /api/videos/:id/stream` - Stream video (HTTP range requests)
- `POST /api/videos/:id/verify` - Verify file availability

## Supported Video Formats

- MP4 (`.mp4`)
- MKV (`.mkv`)
- AVI (`.avi`)
- MOV (`.mov`)
- WMV (`.wmv`)
- FLV (`.flv`)
- WebM (`.webm`)

Format detection is based on file extensions. Additional formats can be added in `src/utils/file-utils.ts`.

## Security Considerations

- **Single-user design** - Registration automatically disabled after first user
- **Session-based auth** - HTTP-only secure cookies, no JWT exposure
- **Password hashing** - bcrypt with 12 rounds
- **Input validation** - Zod schemas on all endpoints
- **Path traversal prevention** - Normalized and validated file paths
- **SQL injection prevention** - Parameterized queries only
- **CORS configuration** - Configured for same-network access

## Performance Notes

- **SQLite optimizations**:
  - WAL mode for better concurrency
  - 64MB cache size
  - Foreign keys enabled
  - Indexes on frequently queried columns

- **Video streaming**: Direct file streaming without buffering entire file
- **Metadata extraction**: Asynchronous processing during indexing
- **Soft deletes**: Missing files marked unavailable instead of removed

## Future Enhancements

Beyond Phase 7, potential features include:
- Playback progress tracking (resume functionality)
- Subtitle file detection and serving (.srt support)
- Video collections/series organization
- Full-text search with SQLite FTS5
- Smart recommendations based on viewing history
- Multiple thumbnail positions (sprite sheets)
- Video transcoding queue system
- Multi-user support with permissions

## Contributing

This is a personal project, but suggestions and bug reports are welcome via issues.

## License

[Add your license here]

## Acknowledgments

- Built with [Bun](https://bun.sh) - The fast all-in-one JavaScript runtime
- Powered by [Fastify](https://fastify.dev) - Fast and low overhead web framework
- Video processing via [FFmpeg](https://ffmpeg.org) - The leading multimedia framework
