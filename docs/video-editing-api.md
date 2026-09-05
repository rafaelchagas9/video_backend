# Video editing workflow

The editor uses one source video, an ordered segment timeline, and asynchronous
MKV/AV1 output jobs. The API at `/docs` is generated from
[edit schemas](../src/modules/edits/edits.schemas.ts) and
[routes](../src/modules/edits/edits.routes.ts). Reuse
[edit types](../src/modules/edits/edits.types.ts) when working inside this backend;
avoid maintaining a second request/response definition in documentation.

## Job lifecycle

1. Load `GET /api/videos/:id/editing-metadata` for source properties, storyboard
   URLs, and capabilities. Feature-detect effects from this response.
2. Submit `POST /api/videos/:id/edits` with a writable output directory, safe
   filename, and timeline. It returns `202` and a `Location` header.
3. Poll `GET /api/edits/jobs/:id` until completed, failed, or cancelled. Recover
   jobs after reload with `GET /api/edits/jobs`, filtered by source/status as needed.
4. Use the completed result's video ID and stream URL. A failed job's error is
   separate from failure to fetch its status.
5. Cancel active work with `POST /api/edits/jobs/:id/cancel`.

Pending/queued jobs advance to running and then completed or failed; cancellation
is terminal. The source is preserved and existing output destinations are not
overwritten. Output is Matroska with AV1 video and Opus or AAC audio.

Job detail also includes a sanitized recipe. To reuse a terminal job, call
`POST /api/edits/jobs/:id/clone` with a new output target and optional replacement
timeline. The clone follows normal creation validation. Recipes do not expose
source paths or reserve a previously used destination.

## Effect order

- Segment start/end refer to source time. Speed changes the segment duration to
  `(end - start) / speed`.
- Segment crop precedes rotation; segment effects run before concatenation.
  If any segment changes geometry, segments are scaled/padded to a common even
  canvas matching the source dimensions, preserving aspect ratio.
- Segment audio effects follow speed adjustment. Fade durations refer to the
  resulting segment duration. Muting contributes silence for the full segment.
- Top-level timeline transform and audio effects run after concatenation. They
  compose with segment effects rather than replacing them.
- Audio settings are accepted for silent sources, but the output remains video-only.

Use `capabilities.timeline.segment_effects` for segment controls and the separate
transform/audio capability entries for final effects. Multi-source timelines,
transitions, overlays, subtitle editing, and audio mixing are outside this API.

## Demo and verification

Demo edits validate and persist the same timeline in isolated SQLite. Polling
advances jobs deterministically from queued to running at 25%, running at 70%,
and completed at 100%, without production media, Redis, or FFmpeg. Output names
starting with `demo-fail-` end with `RENDER_FAILED`; queued/running jobs can be
cancelled. A completed demo job returns an existing playable demo video.

Demo checks prove API/UI behavior, not rendering fidelity. Real FFmpeg behavior
is covered separately by the edit processing tests using synthetic fixtures.
