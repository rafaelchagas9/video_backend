# Video Editing API — Frontend Handoff

This document is the frontend contract for the basic video editor. It describes
the currently implemented API, the supported editing model, demo-mode behavior,
validation rules, and the recommended job lifecycle.

## Base URLs and authentication

| Environment          | URL                                     |
| -------------------- | --------------------------------------- |
| Frontend development | `https://video.lan.rafaelm.dev`         |
| API                  | `https://apivideo.lan.rafaelm.dev`      |
| OpenAPI UI           | `https://apivideo.lan.rafaelm.dev/docs` |

All paths below are relative to the API URL and use the `/api` prefix.

- In production mode, editing routes require the normal authenticated session.
- In demo mode, the backend supplies an isolated demo session automatically.
  The frontend can call these routes without accessing the personal library.
- Cross-origin credentialed requests from the frontend origin are supported.
  Use `credentials: "include"` for production-compatible browser requests.

## Scope

The implemented editor is a **single-source, non-destructive timeline render
API**.
The frontend edits one catalog video by constructing an ordered list of source
time ranges. Submitting the timeline creates a background render job; it does
not modify the source video.

### Supported capabilities

| Area           | Capability        | Contract                                                        |
| -------------- | ----------------- | --------------------------------------------------------------- |
| Timeline       | Trim              | Select a source range with `start` and `end` seconds.           |
| Timeline       | Split             | Represent clips as multiple timeline segments.                  |
| Timeline       | Reorder           | Send segments in the desired output order.                      |
| Timeline       | Speed             | Per segment, from `0.1` to `10`; default is `1`.                |
| Transform      | Crop              | One global normalized crop applied after segment concatenation. |
| Transform      | Rotate            | One global rotation: `0`, `90`, `180`, or `270` degrees.        |
| Audio          | Mute              | Removes audio from the rendered output.                         |
| Audio          | Volume            | Global multiplier from `0` to `4`; default is `1`.              |
| Audio          | Fade in/out       | Global durations in seconds, applied to the edited timeline.    |
| Silent sources | Video-only render | Supported; the backend does not require an audio stream.        |
| Output         | Container         | Matroska (`mkv`) only.                                          |
| Output         | Video codec       | AV1 only.                                                       |
| Output         | Audio codec       | Opus or AAC. Defaults to Opus.                                  |
| Jobs           | Progress          | Pollable `0`–`100` progress.                                    |
| Jobs           | Recovery          | Paginated job listing with video/status filters.                |
| Jobs           | Cancellation      | Cancels queued or running work; terminal calls are idempotent.  |
| Result         | Playback          | Completed jobs return a catalog video ID and range-stream URL.  |

### Explicitly unsupported

- Multi-source timelines
- Transitions
- Text or image overlays
- Subtitle/caption editing
- Multiple audio tracks, music, voice-over, or audio mixing
- Per-segment crop, rotation, volume, or fades
- Arbitrary output containers or video codecs
- In-place source modification

The frontend should use `data.capabilities` from the editing-metadata endpoint
as the runtime source of truth rather than hard-coding future availability.

## Editing model

All times are seconds and may be fractional.

```ts
type EditJobStatus =
  | "pending"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

interface TimelineSegment {
  start: number;
  end: number;
  speed?: number; // 0.1–10, default 1
}

interface NormalizedCrop {
  x: number; // 0–1
  y: number; // 0–1
  width: number; // > 0 and <= 1
  height: number; // > 0 and <= 1
}

interface CreateEditJobBody {
  output: {
    directory_id: number;
    file_name: string;
    format?: "mkv"; // default "mkv"
    video_codec?: "av1"; // default "av1"
    audio_codec?: "opus" | "aac"; // default "opus"
  };
  timeline: {
    segments: TimelineSegment[];
    transform?: {
      crop?: NormalizedCrop;
      rotate?: 0 | 90 | 180 | 270;
    };
    audio?: {
      muted?: boolean; // default false
      volume?: number; // 0–4, default 1
      fade_in_seconds?: number; // default 0
      fade_out_seconds?: number; // default 0
    };
  };
}
```

The edited duration is:

```text
sum((segment.end - segment.start) / (segment.speed ?? 1))
```

Audio fades must each fit within that calculated duration. Crop is applied
before rotation. Audio controls are applied globally after all segments are
concatenated. Muting or using a silent source produces a video-only result.

## Endpoint summary

| Method | Path                                    | Purpose                                                 |
| ------ | --------------------------------------- | ------------------------------------------------------- |
| `GET`  | `/api/directories`                      | Discover valid output `directory_id` values.            |
| `GET`  | `/api/videos/:videoId/editing-metadata` | Load source metadata, storyboard URL, and capabilities. |
| `POST` | `/api/videos/:videoId/edits`            | Validate and create a render job.                       |
| `GET`  | `/api/edits/jobs`                       | Recover/list recent jobs.                               |
| `GET`  | `/api/edits/jobs/:jobId`                | Poll one job and obtain its result.                     |
| `POST` | `/api/edits/jobs/:jobId/cancel`         | Cancel queued or running work.                          |
| `GET`  | `/api/videos/:videoId/thumbnails.vtt`   | Load timeline preview cue data.                         |
| `GET`  | `/api/videos/:videoId/storyboard.jpg`   | Load a JPEG storyboard sprite.                          |
| `GET`  | `/api/videos/:videoId/storyboard.webp`  | Load a WebP storyboard sprite.                          |
| `GET`  | `/api/videos/:videoId/stream`           | Stream source or completed output with byte ranges.     |

## 1. Discover output directories

### `GET /api/directories`

Use an active directory's `id` as `output.directory_id` when creating a job.

```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "path": "demo_mode/video",
      "is_active": true,
      "auto_scan": false,
      "scan_interval_minutes": 30,
      "last_scan_at": "2026-01-01T00:00:00.000Z",
      "added_at": "2026-01-01T00:00:00.000Z",
      "updated_at": "2026-01-01T00:00:00.000Z"
    }
  ]
}
```

The create request fails if the directory does not exist, is inactive, is not
writable, or does not resolve to a directory.

## 2. Load editor metadata and capabilities

### `GET /api/videos/:videoId/editing-metadata`

Call this before constructing the editor. Nullable fields mean the catalog does
not know the value; the frontend should not treat them as zero.

```json
{
  "success": true,
  "data": {
    "id": 1,
    "title": "Example video",
    "duration": 208.061,
    "fps": 24,
    "resolution": {
      "width": 1920,
      "height": 1080
    },
    "bitrate": 9534000,
    "audio": {
      "present": true,
      "codec": "opus",
      "channels": 2,
      "sample_rate": 48000
    },
    "storyboard_vtt": "/api/videos/1/thumbnails.vtt",
    "capabilities": {
      "timeline": {
        "trim": true,
        "split": true,
        "reorder": true,
        "single_source_only": true,
        "speed": { "min": 0.1, "max": 10 }
      },
      "transform": {
        "crop": "normalized",
        "rotate": [0, 90, 180, 270]
      },
      "audio": {
        "mute": true,
        "volume": { "min": 0, "max": 4 },
        "fades": true
      },
      "output": {
        "formats": ["mkv"],
        "video_codecs": ["av1"],
        "audio_codecs": ["opus", "aac"]
      },
      "unsupported": [
        "multi_source_timeline",
        "transitions",
        "text_overlays",
        "subtitle_editing",
        "audio_mixing"
      ]
    }
  }
}
```

If `storyboard_vtt` is `null`, storyboard preview is unavailable. This does not
prevent editing or rendering.

## 3. Create an edit job

### `POST /api/videos/:videoId/edits`

Example containing all supported controls:

```json
{
  "output": {
    "directory_id": 1,
    "file_name": "my-edited-video",
    "format": "mkv",
    "video_codec": "av1",
    "audio_codec": "opus"
  },
  "timeline": {
    "segments": [
      { "start": 0, "end": 8.5, "speed": 1 },
      { "start": 20, "end": 30, "speed": 1.5 },
      { "start": 12, "end": 16, "speed": 0.75 }
    ],
    "transform": {
      "crop": { "x": 0.05, "y": 0.05, "width": 0.9, "height": 0.9 },
      "rotate": 90
    },
    "audio": {
      "muted": false,
      "volume": 0.8,
      "fade_in_seconds": 0.5,
      "fade_out_seconds": 1
    }
  }
}
```

Segments appear in the rendered result in array order. They do not need to be
chronological and may reuse or overlap source ranges.

Success returns HTTP `202 Accepted` and a `Location` header containing the
polling resource.

```http
Location: /api/edits/jobs/42
```

```json
{
  "success": true,
  "data": {
    "job_id": 42,
    "status": "queued",
    "video_id": 1,
    "output": {
      "directory_id": 1,
      "file_name": "my-edited-video.mkv"
    }
  },
  "message": "Render job queued"
}
```

The backend appends `.mkv` when it is missing and normalizes an existing `.MKV`
suffix to `.mkv`. The returned filename is the canonical value and should
replace the frontend's submitted value.

## 4. List and recover jobs

### `GET /api/edits/jobs`

Query parameters:

| Parameter  | Type              | Default | Notes                   |
| ---------- | ----------------- | ------- | ----------------------- |
| `page`     | positive integer  | `1`     | Pagination page.        |
| `limit`    | integer `1`–`100` | `20`    | Items per page.         |
| `video_id` | positive integer  | —       | Filter by source video. |
| `status`   | job status        | —       | Filter by exact status. |

Example:

```http
GET /api/edits/jobs?page=1&limit=20&video_id=1&status=running
```

```json
{
  "success": true,
  "data": [
    {
      "job_id": 42,
      "video_id": 1,
      "status": "running",
      "progress": 37,
      "started_at": "2026-08-11T14:00:00.000Z",
      "completed_at": null,
      "created_at": "2026-08-11T13:59:58.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 1,
    "totalPages": 1
  }
}
```

Jobs are returned newest first. Use this endpoint after application startup or
reload to recover active/recent work. In demo mode, listing is read-only and
does **not** advance simulated progress.

## 5. Poll job status and obtain the result

### `GET /api/edits/jobs/:jobId`

Queued/running response:

```json
{
  "success": true,
  "data": {
    "job_id": 42,
    "status": "running",
    "progress": 70,
    "started_at": "2026-08-11T14:00:00.000Z",
    "completed_at": null
  }
}
```

Completed response:

```json
{
  "success": true,
  "data": {
    "job_id": 42,
    "status": "completed",
    "progress": 100,
    "started_at": "2026-08-11T14:00:00.000Z",
    "completed_at": "2026-08-11T14:02:15.000Z",
    "output": {
      "directory_id": 1,
      "video_id": 145,
      "file_name": "my-edited-video.mkv",
      "stream_url": "/api/videos/145/stream"
    }
  }
}
```

Failed response:

```json
{
  "success": true,
  "data": {
    "job_id": 42,
    "status": "failed",
    "progress": 37,
    "started_at": "2026-08-11T14:00:00.000Z",
    "completed_at": "2026-08-11T14:00:03.000Z",
    "error": {
      "code": "RENDER_FAILED",
      "message": "Video rendering failed"
    }
  }
}
```

The public failure is intentionally generic. Internal FFmpeg errors and local
paths are not returned to the browser. A production failure may retain its last
known progress value; only demo-mode failures are guaranteed to report `100`.

Recommended polling behavior:

1. Start polling the `Location` URL after the `202` response.
2. Poll while status is `pending`, `queued`, or `running`.
3. Stop on `completed`, `failed`, or `cancelled`.
4. Use modest polling such as every 1–2 seconds, with backoff for long renders.
5. On `completed`, use `output.stream_url`; do not construct a path from the
   filename or directory.

## 6. Cancel a job

### `POST /api/edits/jobs/:jobId/cancel`

No body is required.

```json
{
  "success": true,
  "data": {
    "job_id": 42,
    "status": "cancelled"
  }
}
```

- Queued jobs are removed from the queue.
- Running FFmpeg processes are terminated and unpublished temporary/output
  files are cleaned up.
- Cancellation is race-safe: a cancelled job cannot later become completed.
- Calling cancel on `completed`, `failed`, or `cancelled` is idempotent and
  returns the existing terminal status. The frontend must not assume every
  successful cancel request returns `cancelled`.

## 7. Storyboard preview endpoints

### `GET /api/videos/:videoId/thumbnails.vtt`

Returns `text/vtt` containing time ranges and sprite coordinates. The URL is
also returned by `editing-metadata.storyboard_vtt`.

The VTT cues reference one of these sprite endpoints:

- `GET /api/videos/:videoId/storyboard.jpg`
- `GET /api/videos/:videoId/storyboard.webp`

Use the VTT and sprite for source scrubber previews. It represents source time,
not the reordered/edited output timeline. A frontend timeline must map each
edited segment's local time back to its source time before selecting a cue.

## 8. Stream source and completed output

### `GET /api/videos/:videoId/stream`

Supports HTTP byte ranges and returns `200` or `206` with headers such as:

```http
Accept-Ranges: bytes
Content-Range: bytes 0-1048575/241941373
Content-Length: 1048576
Content-Type: video/webm
```

The exact `Content-Type` depends on the catalog video. Use the response header,
not the requested edit filename, to determine the playable media type.

## Job lifecycle

```text
pending/queued -> running -> completed
                       \-> failed
pending/queued/running -> cancelled
```

Terminal statuses are `completed`, `failed`, and `cancelled`.

Production queue behavior:

- Queue claims are acknowledged only after processing settles.
- Interrupted queued/running jobs are recovered after restart.
- Output publication is atomic and never overwrites an existing file.
- A completed output is immediately registered in the video catalog.
- Server shutdown stops new claims, aborts active renders, and waits for cleanup.

## Demo mode

Demo editing is designed for frontend development and remains inside isolated
SQLite/demo assets. It does not initialize or call:

- Production PostgreSQL
- Redis
- FFmpeg/VAAPI
- Personal media paths

### Successful demo scenario

Create any valid job whose filename does not start with `demo-fail-`, then poll
`GET /api/edits/jobs/:jobId`:

| Poll              | Status      | Progress |
| ----------------- | ----------- | -------- |
| Create response   | `queued`    | `0`      |
| First status GET  | `running`   | `25`     |
| Second status GET | `running`   | `70`     |
| Third status GET  | `completed` | `100`    |

For privacy and speed, the completed demo result points to the isolated source
demo video's `video_id` and stream. Therefore its actual stream content type may
be WebM even though the simulated requested output filename ends in `.mkv`.

### Failed demo scenario

Use an output basename beginning with `demo-fail-`:

```json
{
  "output": {
    "directory_id": 1,
    "file_name": "demo-fail-render"
  },
  "timeline": {
    "segments": [{ "start": 0, "end": 3 }]
  }
}
```

It follows the same `25` and `70` progress sequence, then returns `failed` with
`RENDER_FAILED` on the third status poll.

### Cancellation scenario

Create a normal demo job and call its cancel endpoint before it completes. The
job remains `cancelled` on future status calls and does not advance again.

Demo jobs are persisted in SQLite, so they can be rediscovered after a frontend
reload and, in manual reset mode, after a backend restart. An environment using
the on-start demo reset policy may restore the baseline during startup.

## Validation and errors

Normal JSON error shape:

```json
{
  "success": false,
  "error": {
    "message": "Timeline segment 0 exceeds the source duration",
    "statusCode": 400
  }
}
```

| HTTP status | Frontend meaning                                                    |
| ----------- | ------------------------------------------------------------------- |
| `400`       | Invalid path/query/body, timeline, crop, audio, or output settings. |
| `401`       | Missing/expired production session. Not expected in demo mode.      |
| `404`       | Source video, directory, or job does not exist.                     |
| `409`       | Output filename/path collision or active-job reservation conflict.  |
| `500`       | Queue, render, storage, or other internal failure.                  |

Important validation rules:

- Request objects are strict; unknown/obsolete fields are rejected.
- At least one segment is required.
- `start >= 0` and `end > start`.
- Every segment `end` must be within the source duration, with a small
  millisecond tolerance.
- Segment speed must be finite and between `0.1` and `10`.
- Crop values must be finite and normalized.
- `x + width <= 1` and `y + height <= 1`.
- Volume must be from `0` to `4`.
- Fade durations must be non-negative and no longer than edited duration.
- `directory_id` must be a positive integer referencing a valid output
  directory.
- `file_name` must be a basename: no `/`, `\\`, traversal component, or control
  character.
- The canonical filename, including `.mkv`, must be at most 220 UTF-8 bytes.
- Existing files and filenames reserved by active jobs are not overwritten.

## Suggested frontend state

Keep draft timeline state separate from the submitted job snapshot:

```ts
interface EditorState {
  sourceVideoId: number;
  sourceMetadata: EditingMetadata | null;
  segments: TimelineSegment[];
  transform: {
    crop?: NormalizedCrop;
    rotate: 0 | 90 | 180 | 270;
  };
  audio: {
    muted: boolean;
    volume: number;
    fadeInSeconds: number;
    fadeOutSeconds: number;
  };
  output: {
    directoryId: number | null;
    fileName: string;
    audioCodec: "opus" | "aac";
  };
  activeJobId: number | null;
}
```

Recommended initial UI scope:

1. Source player with storyboard scrub previews.
2. Ordered segment/clip timeline with trim, split, delete, reorder, and speed.
3. Global crop/rotation controls.
4. Global mute, volume, and fade controls.
5. Output directory, filename, and audio-codec controls.
6. Render submission and progress/cancel state.
7. Success player using `output.stream_url`.
8. Job recovery/history using `GET /api/edits/jobs`.
9. Deterministic demo success, failure, and cancellation acceptance tests.

## Minimal demo acceptance flow

```text
GET  /api/directories
GET  /api/videos/1/editing-metadata
POST /api/videos/1/edits
GET  /api/edits/jobs/:jobId       # running 25
GET  /api/edits/jobs/:jobId       # running 70
GET  /api/edits/jobs/:jobId       # completed 100
GET  /api/videos/:outputVideoId/stream with Range header
GET  /api/edits/jobs?video_id=1   # reload recovery
```

Use a second job named `demo-fail-frontend-test` for failure UI and a third job
cancelled immediately after creation for cancellation UI.
