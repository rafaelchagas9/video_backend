# Video Streaming Backend

A self-hosted video library manager and streaming server. Indexes local video files, extracts metadata, generates thumbnails and storyboards, transcodes videos, and streams them over HTTP with full range-request support. Includes hierarchical tagging, creator/studio management, playlists, ratings, bookmarks, auto-tagging rules, face recognition and on-demand content analysis via a Python vision service.

Built with Bun + Fastify + PostgreSQL.

## Features

- **Video Indexing** — Automatic scanning from registered directories, recursive file detection, FFprobe metadata extraction (duration, resolution, codecs, bitrate, fps), SHA256 deduplication, soft-delete for missing files
- **Organization** — Creators (with aliases, social links, gallery media, platform profiles), hierarchical tags (parent/child with hex colors), studios, platforms, video collections (series/episodic grouping with season/episode numbering)
- **User Content** — Playlists (custom ordering), favorites (videos + creators), timestamp bookmarks, 1-5 star ratings with comments
- **Media Processing** — Thumbnails (configurable timestamp/position), Vidstack-compatible sprite storyboards (VTT), unified frame extraction, video transcoding (VAAPI GPU acceleration, job queue)
- **Auto-Tagging** — Rule engine with conditions (path pattern, duration, resolution, codec, file size) and actions (add/remove tags, creators, studios)
- **Face Recognition** — Python/InsightFace microservice for face detection, 512-dim embedding extraction, auto-matching to known creators, similarity search
- **Video Editing** — Single-source trim/split/reorder, per-segment speed, crop/rotation, per-segment and global audio controls, and asynchronous MKV/AV1 export jobs
- **Streaming** — HTTP range-request support, chunked delivery
- **Real-Time** — WebSocket multiplayer remote control system (pairing, sessions, display/remote devices), SSE event stream
- **Multiplayer Remote** — Pairing codes, display device management, remote control commands (playback, audio, layout, filters)
- **Analytics** — Watch statistics (plays, watch time, position tracking), library stats snapshots (storage, library composition, content coverage, usage patterns)
- **Authentication** — Better Auth with Drizzle-backed sessions and email/password login
- **Backup** — Full database export/import to JSON
- **Scheduling** — Cron-based directory rescanning, configurable intervals

## Prerequisites

- [Bun](https://bun.sh) 1.3+
- PostgreSQL 14+
- FFmpeg + FFprobe
- Redis (optional, for job queue)
- Python 3.11+ and uv (optional, for the vision/enrichment services)
- Linux, macOS, or WSL2

## Quick Start

```bash
git clone <repo-url>
cd conversor-video
bun install
cp .env.example .env
# Edit .env with your PostgreSQL credentials and SESSION_SECRET
bun db:migrate
bun dev
```

Server starts at `http://localhost:3000`. Swagger UI at `http://localhost:3000/docs`.

## Environment Variables

See `.env.example` for all options. Key variables:

| Variable                       | Description                                                 |
| ------------------------------ | ----------------------------------------------------------- |
| `POSTGRES_*`                   | Database connection                                         |
| `SESSION_SECRET`               | Min 32 chars — used for cookie signing                      |
| `FFMPEG_PATH` / `FFPROBE_PATH` | Paths to FFmpeg binaries                                    |
| `REDIS_URL`                    | Redis connection for job queue (optional)                   |
| `VISION_SERVICE_URL`           | Python vision inference endpoint (optional)                 |
| `DEMO_MODE`                    | Use only isolated demo assets and SQLite-backed state       |
| `DEMO_DATABASE_PATH`           | Isolated demo SQLite file (default `demo_mode/demo.sqlite`) |
| `DEMO_ASSETS_DIR`              | Root allowed for demo media assets (default `demo_mode`)    |
| `DEMO_RESET_MODE`              | Reset mutable demo state `on-start` or only `manual`        |
| `POSTHOG_SERVICE_VERSION`      | Deployed version or Git SHA attached to telemetry           |

## Commands

| Command                     | Description                                                      |
| --------------------------- | ---------------------------------------------------------------- |
| `bun dev`                   | Dev server with auto-reload                                      |
| `bun start`                 | Production server                                                |
| `bun run build`             | Compile TS to JS                                                 |
| `bun run posthog:sourcemaps` | Inject and upload backend source maps (explicit CI auth only)    |
| `bun run start:prod`        | Production from compiled build                                   |
| `bun run validate:env`      | Validate environment variables                                   |
| `bun run check:deps`        | Check PostgreSQL, FFmpeg, directories                            |
| `bun run demo:download`     | Build a fresh SQLite demo catalog and download its curated media |
| `bun run demo:migrate-json` | Explicitly migrate the legacy JSON fixture into demo SQLite      |
| `bun run demo:seed`         | Restore demo SQLite from its existing immutable baseline         |
| `bun run demo:reset`        | Restore the full demo catalog from its immutable SQLite baseline |
| `bun run demo:db:generate`  | Generate migrations for the isolated SQLite schema               |
| `bun run demo:db:migrate`   | Apply migrations to the isolated demo SQLite database            |
| `bun db:generate`           | Generate Drizzle migrations                                      |
| `bun db:migrate`            | Apply pending migrations                                         |
| `bun db:push`               | Direct schema sync (dev only)                                    |
| `bun db:studio`             | Drizzle Studio GUI                                               |
| `bun db:introspect`         | Introspect DB to schema                                          |
| `bunx eslint .`             | Lint                                                             |
| `bunx tsc --noEmit`         | Type check                                                       |

`bun run build` emits an external source map for meaningful production stack
traces. Source-map upload is intentionally not part of the normal build because
maps contain source context. To publish a PostHog release deliberately, set
`POSTHOG_CLI_HOST`, `POSTHOG_CLI_PROJECT_ID`, `POSTHOG_SERVICE_VERSION`
(the exact deployed Git SHA), and a personal
`POSTHOG_CLI_API_KEY` with `error tracking write` and `organization read`, then
run `bun run posthog:sourcemaps`. Set `POSTHOG_SERVICE_VERSION` to the deployed
release or Git SHA; the same value is injected into the bundle, attached to the
upload, and emitted as telemetry resource metadata. The runtime
`POSTHOG_API_KEY` project token must never be used as the CLI credential.

## Demo Mode

Set `DEMO_MODE=true` to expose only the isolated demo library. Demo mode uses a
generic anonymous user and a separate SQLite database for both catalog data and
supported mutations. It never opens the PostgreSQL application database for
demo-backed operations. Asset paths are constrained to `DEMO_ASSETS_DIR`, and
routes that have not been explicitly audited for demo use fail closed with
`DEMO_MODE_ROUTE_BLOCKED`.

The SQLite database is opened lazily only in demo mode, with foreign keys, WAL,
a busy timeout, schema migrations, and an integrity check enabled. In
`DEMO_RESET_MODE=on-start`, startup restores the immutable baseline before
checking the live database, so a missing or empty live SQLite file recovers
automatically. Manual mode preserves live mutations and fails with an actionable
error if the database has not been seeded.

The media itself is intentionally gitignored. Install `yt-dlp`, FFmpeg, and
FFprobe, then run:

```bash
bun run demo:download
```

`demo:download` is the fresh-install path: it can start from an empty SQLite
database, builds the catalog directly, downloads media beneath
`DEMO_ASSETS_DIR`, and refreshes the read-only sibling
`demo.sqlite.baseline`. Artwork generation refreshes that baseline again after
writing its SQLite rows.

`DEMO_ASSETS_DIR/demo_mode.json` and its artwork manifest are legacy migration
inputs, not seed or runtime stores. Existing installations that still need them
can run `bun run demo:migrate-json`; `demo:import-json` remains a compatibility
alias for that explicitly named migration. `DEMO_RESET_MODE=on-start`,
`demo:seed`, and `demo:reset` restore every demo table from the SQLite baseline
without reading legacy JSON at runtime. Manual mode continues to preserve SQLite
mutations across restarts.
The media remains on disk under `DEMO_ASSETS_DIR` and is intentionally
gitignored.

The downloader is idempotent and downloads a curated set of trailers, game
cinematics, live performances, and music videos at the best available quality
capped at 1080p. It also builds thumbnails, metadata, creators, studios, tags,
ratings, bookmarks, and watch statistics for pagination and frontend testing.
Creator and studio artwork, channels, social links, galleries, hierarchical
child tags, storyboard sprite sheets, and WebVTT previews are generated locally.

### Demo video editing

The editing API remains fully inside the demo SQLite/assets boundary: it does
not use the production database, Redis, or FFmpeg. This makes it suitable for
frontend development without exposing the personal video library. Demo jobs
advance deterministically as they are polled: `queued` → `running` (25%) →
`running` (70%) → `completed` (100%). A completed response includes a playable
demo `video_id` and `/api/videos/:id/stream` URL.

To exercise the editor's error UI, create a job whose output basename starts
with `demo-fail-`. It follows the same progress sequence and then finishes with
a deterministic `RENDER_FAILED` error. Cancellation is available while a job
is queued or running, and jobs can be rediscovered after a frontend reload with
`GET /api/edits/jobs`.

## Code and documentation

Application modules live in [src/modules](src/modules), PostgreSQL schemas and
migrations in [src/database](src/database), and the isolated demo repository in
[src/database/demo](src/database/demo). Request/response schemas alongside each
module generate the API documentation at `/docs`.

- [Vision service](vision-service/README.md): face and nudity inference setup.
- [Enrichment service](enrichment-service/README.md): external metadata candidates.
- [Editing workflow](docs/video-editing-api.md): job lifecycle and effect semantics.
- [Artwork](docs/artwork-api-contract.md): client rendering and regeneration.
- [Performance](docs/performance.md): scheduling, tuning, and measured limits.
- [Remaining work](plans/README.md): unresolved product decisions and acceptance gates.

## Testing

Do not pass multiple unit/demo/integration files to one `bun test` process.
Those files mutate runtime configuration, and Bun shares the module cache between
them. Use the process-isolated runner instead:

```bash
bun run test:files -- tests/example.test.ts tests/integration/example.integration.test.ts
```

`bun run test:unit` and `bun run test:integration` also isolate every file in a
separate process. Test-mode PostgreSQL access fails closed unless the active
target is the loopback `test_user@conversor_video_test` database.

## API

All application routes are prefixed with `/api` and documented via Swagger at
`/docs`.

Health check: `GET /health`

See the [editing workflow](docs/video-editing-api.md) for asynchronous edits,
per-segment effects, recipe reuse, and the demo lifecycle. Request fields and
limits are defined by [the edit schemas](src/modules/edits/edits.schemas.ts).

### First-Time Setup

The first registration creates the library owner. Both registration endpoints
close once an account exists; existing accounts can continue signing in.

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
- **Vision**: InsightFace and NudeNet via the native Python/ONNX Runtime service; see its setup guide for the pinned runtime.
