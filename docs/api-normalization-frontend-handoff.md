# API Normalization Frontend Handoff

This file only lists API normalization changes that require frontend attention.

If a backend refactor did not change a public path, request contract, or response contract, it is intentionally omitted here.

## 2026-05-29 - Conversions

What changed:

- `POST /api/videos/:id/convert` -> `POST /api/videos/:id/conversions`
- `POST /api/videos/convert/bulk` -> `POST /api/conversions`
- `GET /api/videos/convert/queue` -> `GET /api/conversions/queue`
- `GET /api/conversion/status` -> `GET /api/conversions/queue/status`
- `POST /api/conversions/:id/cancel` -> `PATCH /api/conversions/:id`
- `GET /api/presets` -> `GET /api/conversions/presets`

Frontend action:

- Move callers to the new endpoints.
- For cancellation, send `PATCH /api/conversions/:id` with `{ "status": "cancelled" }`.
- Do not build new work against the deprecated paths even though they still respond.

Request impact:

- Auth is unchanged.
- Bulk creation body is unchanged; only the path moved to `POST /api/conversions`.
- Queue status moved from `/api/conversion/status` to `/api/conversions/queue/status`.

Response impact:

- Main conversion envelopes are unchanged: `{ success, data }`.
- Deprecated endpoints now return deprecation headers: `Deprecation`, `Sunset`, `Warning`, `Link`.
- `GET /api/conversions/history/overview` is now explicitly the aggregate overview endpoint. Do not treat it like the history list response.

## 2026-05-29 - Triage

What changed:

- `GET /api/users/triage-progress` -> `GET /api/triage/progress`
- `POST /api/users/triage-progress` -> `POST /api/triage/progress`
- `POST /api/users/triage/bulk-actions` -> `POST /api/triage/bulk-actions`
- `GET /api/users/triage/statistics` -> `GET /api/triage/stats`

Frontend action:

- Update all triage callers to `/api/triage/*`.

Request impact:

- Query params, body, and auth are unchanged.

Response impact:

- Response shapes are unchanged.
- Old `/api/users/*` routes still work for now and return deprecation headers.

## 2026-05-29 - Stats Snapshot Triggers

What changed:

- `POST /api/stats/storage/snapshot` -> `POST /api/stats/storage-snapshots`
- `POST /api/stats/library/snapshot` -> `POST /api/stats/library-snapshots`
- `POST /api/stats/content/snapshot` -> `POST /api/stats/content-snapshots`
- `POST /api/stats/usage/snapshot` -> `POST /api/stats/usage-snapshots`
- `POST /api/stats/snapshot` -> `POST /api/stats/snapshots`

Frontend action:

- Update any manual snapshot trigger buttons or admin tools to the new paths.

Request impact:

- Auth is unchanged.
- No body or query changes.

Response impact:

- Response shapes are unchanged.
- Old snapshot trigger paths still work for now and return deprecation headers.

## 2026-05-29 - Thumbnail And Storyboard Asset URLs

What changed:

- `GET /api/videos/:id/thumbnails` and `POST /api/videos/:id/thumbnails` now return thumbnail objects with `asset_url`.
- `GET /api/videos/:id/storyboard` now returns storyboard metadata with `sprite_url` and `vtt_url`.
- New metadata endpoint: `GET /api/thumbnails/:id`.

Frontend action:

- Stop constructing thumbnail and storyboard asset URLs manually when metadata already provides them.
- Prefer `asset_url`, `sprite_url`, and `vtt_url` from the API response.

Request impact:

- Existing thumbnail and storyboard paths still exist.
- Auth is unchanged for metadata endpoints.

Response impact:

- Thumbnail metadata now includes `asset_url`.
- Storyboard metadata now includes `sprite_url` and `vtt_url`.

## 2026-05-29 - Scoped Video Lists

What changed:

- `GET /api/creators/:id/videos`
- `GET /api/tags/:id/videos`
- `GET /api/studios/:id/videos`

The paths did not change. Their contract did.

Frontend action:

- Treat these endpoints exactly like `GET /api/videos`.
- Reuse the same list parsing, pagination handling, and include handling used for the main video list.
- Remove any frontend assumptions that these endpoints return a plain array or a smaller custom video shape.

Request impact:

- These endpoints now accept the canonical `GET /api/videos` query contract, including pagination, sorting, filtering, and `include`.

Response impact:

- The response changed from `{ success, data: Video[] }` to `{ success, data, pagination }`.
- Video objects now follow the canonical video list shape used by `GET /api/videos`.
- Derived fields such as `thumbnail_url` now follow the same contract as `GET /api/videos`.
