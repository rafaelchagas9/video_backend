# Video Streaming Backend

A self-hosted video library manager and streaming server. Indexes local video files, extracts metadata, generates thumbnails and storyboards, transcodes videos, and streams them over HTTP with full range-request support. Includes hierarchical tagging, creator/studio management, playlists, ratings, bookmarks, auto-tagging rules, and face recognition via a Python/InsightFace microservice.

Built with Bun + Fastify + PostgreSQL.

## Features

- **Video Indexing** — Automatic scanning from registered directories, recursive file detection, FFprobe metadata extraction (duration, resolution, codecs, bitrate, fps), SHA256 deduplication, soft-delete for missing files
- **Organization** — Creators (with aliases, social links, gallery media, platform profiles), hierarchical tags (parent/child with hex colors), studios, platforms, video collections (series/episodic grouping with season/episode numbering)
- **User Content** — Playlists (custom ordering), favorites (videos + creators), timestamp bookmarks, 1-5 star ratings with comments
- **Media Processing** — Thumbnails (configurable timestamp/position), Vidstack-compatible sprite storyboards (VTT), unified frame extraction, video transcoding (VAAPI GPU acceleration, job queue)
- **Auto-Tagging** — Rule engine with conditions (path pattern, duration, resolution, codec, file size) and actions (add/remove tags, creators, studios)
- **Face Recognition** — Python/InsightFace microservice for face detection, 512-dim embedding extraction, auto-matching to known creators, similarity search
- **Video Editing** — Timeline-based trimming jobs with configurable output codecs
- **Streaming** — HTTP range-request support, chunked delivery
- **Real-Time** — WebSocket multiplayer remote control system (pairing, sessions, display/remote devices), SSE event stream
- **Multiplayer Remote** — Pairing codes, display device management, remote control commands (playback, audio, layout, filters)
- **Analytics** — Watch statistics (plays, watch time, position tracking), library stats snapshots (storage, library composition, content coverage, usage patterns)
- **Authentication** — Better Auth with Drizzle-backed sessions, email/password, single-user with auto-disabled registration
- **Backup** — Full database export/import to JSON
- **Scheduling** — Cron-based directory rescanning, configurable intervals

## Prerequisites

- [Bun](https://bun.sh) 1.3+
- PostgreSQL 14+
- FFmpeg + FFprobe
- Redis (optional, for job queue)
- Python 3.12+ (optional, for face recognition service)
- Linux, macOS, or WSL2

## Quick Start

```bash
git clone <repo-url>
cd conversor-video
bun install
cp .env.example .env
# Edit .env with your PostgreSQL credentials and SESSION_SECRET
bun db:generate
bun db:migrate
bun dev
```

Server starts at `http://localhost:3000`. Swagger UI at `http://localhost:3000/docs`.

## Environment Variables

See `.env.example` for all options. Key variables:

| Variable | Description |
|---|---|
| `POSTGRES_*` | Database connection |
| `SESSION_SECRET` | Min 32 chars — used for cookie signing |
| `FFMPEG_PATH` / `FFPROBE_PATH` | Paths to FFmpeg binaries |
| `REDIS_URL` | Redis connection for job queue (optional) |
| `FACE_SERVICE_URL` | Python face service endpoint (optional) |

## Commands

| Command | Description |
|---|---|
| `bun dev` | Dev server with auto-reload |
| `bun start` | Production server |
| `bun run build` | Compile TS to JS |
| `bun run start:prod` | Production from compiled build |
| `bun run validate:env` | Validate environment variables |
| `bun run check:deps` | Check PostgreSQL, FFmpeg, directories |
| `bun db:generate` | Generate Drizzle migrations |
| `bun db:migrate` | Apply pending migrations |
| `bun db:push` | Direct schema sync (dev only) |
| `bun db:studio` | Drizzle Studio GUI |
| `bun db:introspect` | Introspect DB to schema |
| `bun db:apply-migration` | Run custom migration script |
| `bunx eslint .` | Lint |
| `bunx tsc --noEmit` | Type check |

## Project Structure

```
src/
├── index.ts                     # Entry point
├── server.ts                    # Fastify server setup + route registration
├── config/
│   ├── database.ts              # DB connection pool
│   ├── drizzle.ts               # Drizzle ORM setup
│   └── env.ts                   # Env validation
├── database/
│   ├── schema/                  # 18 schema files, 40 tables
│   │   ├── users.schema.ts      # Auth (users, sessions, accounts)
│   │   ├── videos.schema.ts     # Core video records + stats + metadata
│   │   ├── organization.schema.ts # Creators, tags, studios, platforms
│   │   ├── content.schema.ts    # Playlists, favorites, bookmarks, ratings
│   │   ├── video-collections.schema.ts # Series/episodic grouping
│   │   ├── media.schema.ts      # Thumbnails, storyboards
│   │   ├── conversion.schema.ts # Transcoding jobs
│   │   ├── edits.schema.ts      # Video editing jobs
│   │   ├── stats.schema.ts      # Analytics snapshots
│   │   ├── tagging.schema.ts    # Auto-tagging rules
│   │   ├── face-recognition.schema.ts # Face embeddings, detections
│   │   ├── multiplayer-remote.schema.ts # Remote control sessions
│   │   ├── app-settings.schema.ts
│   │   └── triage.schema.ts
│   └── drizzle-migrations/      # Generated SQL migrations
├── modules/
│   ├── auth/                    # Authentication (Better Auth)
│   ├── videos/                  # Video CRUD, search, streaming, metadata
│   ├── directories/             # Watched directory management + scanning
│   ├── creators/                # Creator/performer management
│   ├── studios/                 # Studio management
│   ├── platforms/               # Platform reference data
│   ├── tags/                    # Hierarchical tags
│   ├── auto-tagging/            # Auto-tagging logic
│   ├── tagging-rules/           # Rule engine (conditions + actions)
│   ├── ratings/                 # 1-5 star ratings
│   ├── favorites/               # Video + creator favorites
│   ├── bookmarks/               # Timestamp bookmarks
│   ├── playlists/               # Playlist management
│   ├── video-collections/       # Series/episodic collections
│   ├── thumbnails/              # Thumbnail generation
│   ├── storyboards/             # Sprite storyboards (Vidstack)
│   ├── frame-extraction/        # Unified frame extraction
│   ├── face-recognition/        # Face detection + matching
│   ├── conversion/              # Video transcoding queue
│   ├── edits/                   # Video trimming/editing jobs
│   ├── video-stats/             # Watch statistics
│   ├── stats/                   # Library analytics snapshots
│   ├── scheduler/               # Cron-based scanning
│   ├── events/                  # SSE event stream
│   ├── multiplayer-remote/      # WebSocket remote control
│   ├── settings/                # App configuration
│   └── backup/                  # Database backup/restore
├── utils/
│   ├── errors.ts                # AppError base class
│   ├── validation.ts            # validateSchema helper
│   ├── logger.ts                # Pino logger
│   └── file-utils.ts            # File operations
├── scripts/
│   ├── validate-env.ts
│   └── check-dependencies.ts
└── demo_mode/                   # Demo data generation
```

Face recognition requires a separate Python microservice at `face-service/` (InsightFace, FastAPI port 8100). See `face-service/README.md`.

## API

All routes are prefixed with `/api/v1` and documented via Swagger at `/docs`.

Health check: `GET /health`

### First-Time Setup

```bash
# Register first user
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email": "admin@example.com", "name": "Admin", "password": "your-password"}'

# Login
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "admin@example.com", "password": "your-password"}' \
  -c cookies.txt

# Register a directory to scan
curl -X POST http://localhost:3000/api/directories \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{"path": "/path/to/videos", "auto_scan": true, "scan_interval_minutes": 30}'
```

## Supported Formats

MP4, MKV, AVI, MOV, WMV, FLV, WebM, M4V, MPEG, MPV, OGM, RMVB

## Video Processing Backends

- **Thumbnails/Storyboards**: FFmpeg with configurable quality, format, size
- **Conversion**: VAAPI hardware acceleration (Linux/Intel GPU), fallback software
- **Face Recognition**: InsightFace via Python microservice (CUDA/ROCm supported)
