# Video Streaming Backend

A TypeScript/Bun backend application for managing and streaming local video files. Built with Fastify and PostgreSQL, this single-user system provides video indexing, metadata management, and HTTP streaming with support for hierarchical organization, creators, tags, ratings, playlists, bookmarks, and face recognition.

## Features

### Video Management

- Automatic video indexing from registered directories
- Recursive directory scanning with file detection
- Metadata extraction (duration, resolution, codecs, bitrate, fps) via FFprobe
- SHA256 file hashing for deduplication detection
- Soft-delete for missing files (availability tracking)
- UTF-8 filename support (tested with special characters)

### Media Organization

- Creator management with many-to-many video associations
- Hierarchical tags with recursive queries (parent/child relationships)
- Custom metadata key-value storage per video
- Tag tree navigation and filtering
- Studios and platforms support

### User Experience

- Playlist creation with custom ordering
- Favorites/watchlist functionality
- Video bookmarks with timestamps
- 1-5 star rating system with optional comments
- Automatic thumbnail generation at configurable timestamps

### Advanced Features

- HTTP range request video streaming
- Scheduled directory scanning with node-cron
- Storyboard generation for video scrubbing
- Face recognition with auto-tagging
- Background conversion queue (VAAPI GPU acceleration)
- Redis-based job queue for async processing
- Database backup/export utilities

### Authentication & Security

- Session-based authentication with bcrypt password hashing
- Single-user system with registration lock after first user
- HTTP-only secure cookies with configurable expiration
- Rate limiting and security headers

## Technology Stack

- **Runtime**: [Bun](https://bun.sh) - Fast JavaScript runtime
- **Framework**: [Fastify](https://fastify.dev) - High-performance web framework
- **Database**: PostgreSQL with [Drizzle ORM](https://orm.drizzle.team)
- **Authentication**: bcrypt + session-based cookies
- **Validation**: [Zod](https://zod.dev) - TypeScript-first schema validation
- **Logging**: [Pino](https://getpino.io) - Fast JSON logger
- **Video Processing**: FFmpeg/FFprobe
- **Queue**: Redis with BullMQ pattern
- **Testing**: Bun's built-in test runner

## Prerequisites

- [Bun](https://bun.sh) v1.3 or higher
- PostgreSQL 14+
- [FFmpeg](https://ffmpeg.org) and FFprobe
- Redis (optional, for job queues)
- Linux, macOS, or WSL2

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
   # Edit .env with your PostgreSQL credentials and SESSION_SECRET
   ```

4. **Setup database**

   ```bash
   bun db:generate
   bun db:migrate
   ```

5. **Verify FFmpeg installation**
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

Build and start the production server:

```bash
bun run build
bun run start:prod
```

The production startup includes:

- Environment variable validation
- Dependency checks (PostgreSQL, FFmpeg, required directories)
- Automatic migration of any pending database changes
- Running compiled JavaScript instead of TypeScript on-the-fly

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
     -d '{"path": "/path/to/your/videos", "auto_scan": true, "scan_interval_minutes": 30}'
   ```

The system will automatically scan the directory and index all video files.

### API Documentation

Access Swagger UI documentation at: `http://localhost:3000/docs`

### Health Check

```bash
curl http://localhost:3000/health
```

## Testing

```bash
bun test                    # Run all tests
bun test tests/integration/auth.test.ts  # Run specific file
bun test --filter "should register"      # Run by pattern
```

## Project Structure

```
src/
├── index.ts                    # Application entry point
├── server.ts                   # Fastify server setup
├── config/
│   ├── database.ts             # Drizzle database connection
│   ├── drizzle.ts              # Drizzle config and schema
│   └── env.ts                  # Environment variable validation
├── database/
│   ├── schema/                 # Drizzle table definitions
│   └── migrations/             # Generated migrations
├── modules/
│   ├── auth/                   # Authentication and sessions
│   ├── directories/            # Directory registration and scanning
│   ├── videos/                 # Video CRUD, metadata, streaming
│   ├── creators/               # Creator management
│   ├── studios/                # Studio management
│   ├── platforms/              # Platform management
│   ├── tags/                   # Tag management
│   ├── thumbnails/             # Thumbnail generation
│   ├── storyboards/            # Storyboard/sprite generation
│   ├── playlists/              # Playlist management
│   ├── favorites/              # Favorites management
│   ├── bookmarks/              # Video bookmarks
│   ├── ratings/                # Rating system
│   ├── auto-tagging/           # Auto-tagging rules
│   ├── face-recognition/       # Face detection and recognition
│   ├── frame-extraction/       # Unified frame extraction
│   ├── video-stats/            # Video view statistics
│   ├── stats/                  # Library statistics
│   ├── settings/               # Application settings
│   ├── scheduler/              # Cron-based scheduling
│   ├── backup/                 # Database backup
│   ├── websocket/              # WebSocket support
│   └── conversion/             # Video conversion queue
└── utils/
    ├── errors.ts               # Custom error classes
    ├── validation.ts           # Zod validation helpers
    ├── logger.ts               # Pino logger configuration
    └── file-utils.ts           # File operations
```

## Environment Variables

Required PostgreSQL variables:

```bash
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DB=video_streaming_db
POSTGRES_USER=your_user
POSTGRES_PASSWORD=your_password
POSTGRES_MAX_CONNECTIONS=20
```

Other important keys:

```bash
SESSION_SECRET=your-32-char-minimum-secret
FFMPEG_PATH=/usr/bin/ffmpeg
FFPROBE_PATH=/usr/bin/ffprobe
```

See `.env.example` for all available options.

## Supported Video Formats

- MP4, MKV, AVI, MOV, WMV, FLV, WebM, M4V, MPEG, MPV, OGM, RMVB

Format detection is based on file extensions. Add more in `src/utils/file-utils.ts`.

## Commands

| Command                | Description                                      |
| ---------------------- | ------------------------------------------------ |
| `bun dev`              | Start dev server with auto-reload                |
| `bun start`            | Start production server (from TypeScript source) |
| `bun run build`        | Compile TypeScript to JavaScript                 |
| `bun run start:prod`   | Start production server (from compiled build)    |
| `bun run validate:env` | Validate environment variables                   |
| `bun run check:deps`   | Check dependencies (PostgreSQL, FFmpeg, dirs)    |
| `bun db:generate`      | Generate Drizzle migrations                      |
| `bun db:migrate`       | Apply pending migrations                         |
| `bun db:push`          | Push schema (dev only)                           |
| `bun db:studio`        | Open Drizzle Studio GUI                          |
| `bun test`             | Run all tests                                    |
| `bunx eslint .`        | Run linter                                       |
| `bunx tsc --noEmit`    | Type check                                       |

## Security

- Single-user design with registration auto-disable
- HTTP-only secure cookies, no JWT exposure
- bcrypt password hashing (12 rounds)
- Zod schemas on all endpoints
- Path traversal prevention
- Parameterized queries (Drizzle ORM)
- Rate limiting and security headers (Fastify Helmet)

## Contributing

This is a personal project. Suggestions and bug reports via issues are welcome.

## License

[Add your license here]
