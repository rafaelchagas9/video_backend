# Frontend Handoff - Backend Overview

This document gives a first-pass map of the current backend so frontend work can start in parallel. In the next phase, we should document each endpoint's parameters, response shapes, edge cases, and UX treatments in detail.

## 1) High-level architecture

- Base API prefix: `/api`
- Swagger/OpenAPI UI: `/docs`
- Health check: `/health`
- Authentication model: Better Auth cookie-based session (`session_id`)
- Realtime model: **Server-Sent Events (SSE)** via `/api/events/stream`
- Main protocol style: JSON envelope with `success`, plus `data` and optionally `message` (some endpoints use custom top-level keys)

## 2) Authentication and session behavior

### Auth endpoints

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`

### Important auth notes for frontend

- Sessions are Better Auth-managed and cookie-based (`HttpOnly` cookie `session_id`), not bearer-token based.
- Frontend must send credentials in requests (`credentials: "include"`).
- Cookie settings are managed by Better Auth; frontend should treat them as opaque and always send `credentials: "include"`.
- Most endpoints require auth (`authenticateUser` middleware).
- If session expires, API returns `401` and SSE may emit `auth:expired` before closing stream.

## 3) Realtime (SSE)

### SSE endpoint

- `GET /api/events/stream` (authenticated)

### Behavior

- Response content type: `text/event-stream`
- Keepalive comments sent every 20s
- Session validity rechecked every 30s
- On invalid session: emits `event: auth:expired` then disconnects

### Observed event types currently broadcast

- `conversion:started`
- `conversion:progress`
- `conversion:completed`
- `conversion:failed`
- `conversion:batch_completed`
- `storyboard:generating`
- `storyboard:ready`
- `storyboard:error`
- `face:extraction_started`
- `face:extraction_complete`
- `face:extraction_error`
- `auth:expired`

## 4) Public vs protected routes

### Public routes

- `GET /health`
- `POST /api/auth/register`
- `POST /api/auth/login`
- Storyboard/media preview routes:
  - `GET /api/videos/:id/thumbnails.vtt`
  - `GET /api/videos/:id/storyboard.jpg`
  - `GET /api/videos/:id/storyboard.webp`

### Protected routes

- Everything else listed below under API map.

## 5) API map (current endpoints)

All paths below already include `/api`.

### Auth

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`

### Directories

- `POST /api/directories`
- `GET /api/directories`
- `GET /api/directories/:id`
- `PATCH /api/directories/:id`
- `DELETE /api/directories/:id`
- `POST /api/directories/:id/scan`
- `GET /api/directories/:id/stats`

### Videos

- `GET /api/videos`
- `GET /api/videos/compression-suggestions`
- `GET /api/videos/next`
- `GET /api/videos/triage-queue`
- `POST /api/videos/bulk/delete`
- `POST /api/videos/bulk/creators`
- `POST /api/videos/bulk/tags`
- `POST /api/videos/bulk/studios`
- `POST /api/videos/bulk/favorites`
- `POST /api/videos/bulk/conditional-apply`
- `GET /api/videos/random`
- `GET /api/videos/duplicates`
- `GET /api/videos/:id`
- `PATCH /api/videos/:id`
- `DELETE /api/videos/:id`
- `POST /api/videos/:id/verify`
- `POST /api/videos/:id/refresh`
- `GET /api/videos/:id/stream`
- `GET /api/videos/:id/creators`
- `POST /api/videos/:id/creators`
- `DELETE /api/videos/:id/creators/:creator_id`
- `GET /api/videos/:id/tags`
- `POST /api/videos/:id/tags`
- `DELETE /api/videos/:id/tags/:tag_id`
- `GET /api/videos/:id/metadata`
- `POST /api/videos/:id/metadata`
- `DELETE /api/videos/:id/metadata/:key`
- `GET /api/videos/:id/ratings`
- `POST /api/videos/:id/ratings`
- `GET /api/videos/:id/bookmarks`
- `POST /api/videos/:id/bookmarks`
- `GET /api/videos/:id/studios`
- `POST /api/videos/:id/studios/:studio_id`
- `DELETE /api/videos/:id/studios/:studio_id`

### Creators

- `GET /api/creators`
- `GET /api/creators/:id`
- `POST /api/creators`
- `POST /api/creators/bulk`
- `PATCH /api/creators/:id`
- `DELETE /api/creators/:id`
- `GET /api/creators/:id/videos`
- `POST /api/creators/:id/picture`
- `GET /api/creators/:id/picture`
- `DELETE /api/creators/:id/picture`
- `POST /api/creators/:id/platforms`
- `GET /api/creators/:id/platforms`
- `PATCH /api/creators/:id/platforms/:platformId`
- `DELETE /api/creators/:id/platforms/:platformId`
- `POST /api/creators/:id/social-links`
- `POST /api/creators/:id/platforms/bulk`
- `POST /api/creators/:id/social-links/bulk`
- `POST /api/creators/:id/picture-from-url`
- `GET /api/creators/:id/social-links`
- `PATCH /api/creators/:id/social-links/:linkId`
- `DELETE /api/creators/:id/social-links/:linkId`
- `POST /api/creators/:id/studios/:studioId`
- `GET /api/creators/:id/studios`
- `DELETE /api/creators/:id/studios/:studioId`
- `GET /api/creators/autocomplete`
- `GET /api/creators/recent`
- `POST /api/creators/quick-create`

### Studios

- `GET /api/studios`
- `GET /api/studios/:id`
- `POST /api/studios`
- `POST /api/studios/bulk`
- `PATCH /api/studios/:id`
- `DELETE /api/studios/:id`
- `POST /api/studios/:id/picture`
- `GET /api/studios/:id/picture`
- `DELETE /api/studios/:id/picture`
- `POST /api/studios/:id/social-links`
- `POST /api/studios/:id/social-links/bulk`
- `POST /api/studios/:id/picture-from-url`
- `GET /api/studios/:id/social-links`
- `PATCH /api/studios/:id/social-links/:linkId`
- `DELETE /api/studios/:id/social-links/:linkId`
- `POST /api/studios/:id/creators/bulk`
- `POST /api/studios/:id/creators/:creatorId`
- `GET /api/studios/:id/creators`
- `DELETE /api/studios/:id/creators/:creatorId`
- `POST /api/studios/:id/videos/:videoId`
- `GET /api/studios/:id/videos`
- `DELETE /api/studios/:id/videos/:videoId`
- `GET /api/studios/autocomplete`
- `GET /api/studios/recent`
- `POST /api/studios/quick-create`

### Tags

- `GET /api/tags`
- `GET /api/tags/:id`
- `POST /api/tags`
- `PATCH /api/tags/:id`
- `DELETE /api/tags/:id`
- `GET /api/tags/:id/children`
- `GET /api/tags/:id/videos`

### Tagging rules

- `GET /api/tagging-rules`
- `GET /api/tagging-rules/:id`
- `POST /api/tagging-rules`
- `PATCH /api/tagging-rules/:id`
- `DELETE /api/tagging-rules/:id`
- `POST /api/tagging-rules/bulk/delete`
- `POST /api/tagging-rules/:id/test`
- `POST /api/tagging-rules/apply`

### Ratings

- `PATCH /api/ratings/:id`
- `DELETE /api/ratings/:id`

### Bookmarks

- `PATCH /api/bookmarks/:id`
- `DELETE /api/bookmarks/:id`

### Favorites

- `GET /api/favorites`
- `POST /api/favorites`
- `DELETE /api/favorites/:video_id`
- `GET /api/favorites/:video_id/check`

### Playlists

- `POST /api/playlists`
- `GET /api/playlists`
- `GET /api/playlists/:id`
- `PATCH /api/playlists/:id`
- `DELETE /api/playlists/:id`
- `GET /api/playlists/:id/videos`
- `POST /api/playlists/:id/videos/bulk`
- `POST /api/playlists/:id/videos`
- `DELETE /api/playlists/:id/videos/:video_id`
- `PATCH /api/playlists/:id/videos/reorder`

### Thumbnails

- `POST /api/videos/:id/thumbnails`
- `GET /api/videos/:id/thumbnails`
- `GET /api/thumbnails/:id/image`
- `DELETE /api/thumbnails/:id`

### Storyboards

- `GET /api/videos/:id/thumbnails.vtt` (public)
- `GET /api/videos/:id/storyboard.jpg` (public)
- `GET /api/videos/:id/storyboard.webp` (public)
- `POST /api/videos/:id/storyboard`
- `DELETE /api/videos/:id/storyboard`
- `GET /api/videos/:id/storyboard`

### Face recognition

- `GET /api/faces/health`
- `POST /api/creators/:id/face-embeddings`
- `POST /api/creators/:id/face-embeddings/base64`
- `GET /api/creators/:id/face-embeddings`
- `PUT /api/creators/:id/face-embeddings/:eid/primary`
- `DELETE /api/creators/:id/face-embeddings/:eid`
- `GET /api/creators/:id/face-embeddings/:eid/thumbnail`
- `GET /api/videos/:id/faces`
- `GET /api/faces/:id/image`
- `POST /api/videos/:id/faces/extract`
- `PUT /api/videos/:id/faces/:did/confirm`
- `PUT /api/videos/:id/faces/:did/reject`
- `GET /api/creators/:id/videos-by-face`
- `POST /api/faces/search`
- `GET /api/videos/:id/faces/status`
- `DELETE /api/faces/queue`

### Conversion

- `POST /api/videos/:id/convert`
- `POST /api/videos/convert/bulk`
- `GET /api/videos/convert/queue`
- `GET /api/videos/:id/conversions`
- `GET /api/conversions/history`
- `GET /api/conversions/history/overview`
- `GET /api/conversions/:id`
- `POST /api/conversions/:id/cancel`
- `DELETE /api/conversions/:id`
- `GET /api/conversions/:id/download`
- `GET /api/presets`
- `GET /api/conversion/status`
- `GET /api/conversions/active`
- `POST /api/conversions/queue/clear`

### Edits

- `GET /api/videos/:id/editing-metadata`
- `POST /api/videos/:id/edits`
- `GET /api/edits/jobs/:id`
- `POST /api/edits/jobs/:id/cancel`

### Backup

- `POST /api/backup`
- `GET /api/backup`
- `GET /api/backup/export`
- `POST /api/backup/:filename/restore`
- `DELETE /api/backup/:filename`

### Stats

- `GET /api/stats/storage`
- `GET /api/stats/storage/history`
- `POST /api/stats/storage/snapshot`
- `GET /api/stats/library`
- `GET /api/stats/library/history`
- `POST /api/stats/library/snapshot`
- `GET /api/stats/content`
- `GET /api/stats/content/history`
- `POST /api/stats/content/snapshot`
- `GET /api/stats/usage`
- `GET /api/stats/usage/history`
- `POST /api/stats/usage/snapshot`
- `POST /api/stats/snapshot`

### Video stats

- `POST /api/videos/:id/watch`
- `GET /api/videos/:id/stats`

### Triage (registered under `/users`)

- `POST /api/users/triage-progress`
- `GET /api/users/triage-progress`
- `POST /api/users/triage/bulk-actions`
- `GET /api/users/triage/statistics`

### Events

- `GET /api/events/stream`

## 6) Frontend integration cautions

1. Cookie auth + CORS: always use `credentials: "include"` and configure frontend origin in backend CORS allowlist.
2. Streaming endpoint: `/api/videos/:id/stream` supports `Range`; player must handle `206` and progressive loading.
3. Mixed content responses: some endpoints return binary streams/files/images (`stream`, thumbnail/storyboard image, conversion download), not JSON.
4. Multipart endpoints exist for file uploads (creator/studio picture and face embedding routes).
5. Some routes are async job oriented (conversion/edits/storyboard/face extraction), so frontend should poll job endpoints and/or listen to SSE.
6. Response envelope is mostly consistent, but there are module-level variations (`data`, `ids`, `total`, `meta`, etc.) to normalize in a frontend API client layer.
7. Public storyboard assets are intentionally unauthenticated and cacheable (`max-age=86400`), suitable for direct player fetches.
8. Error model generally follows `{ success: false, error: { message, statusCode } }`; validation failures include additional details.

## 7) Suggested breakdown for next documentation phase

Create one spec file per domain and document for each endpoint:

- Exact request contract: path params, query params, body schema, headers, content type.
- Exact response contract: success payload, error payloads by status code, pagination/meta fields.
- UI behavior notes: loading states, empty states, retries, optimistic updates, race conditions.
- Realtime behavior: which SSE events affect each screen and required state updates.
- Media handling: streaming, range requests, binary/image endpoints, cache strategy.

Recommended order to reduce integration risk:

1. Auth + session bootstrap (`/auth/*`, `/events/stream`)
2. Video listing/detail + stream + triage navigation (`/videos`, `/videos/:id`, `/videos/:id/stream`, `/videos/next`, `/videos/triage-queue`)
3. Core associations (creators/studios/tags/favorites/bookmarks/ratings)
4. Async processing flows (conversion, edits, storyboards, face recognition)
5. Secondary modules (playlists, stats, backup, tagging rules)

## 8) Notes on currently unused realtime channel

There is a WebSocket service module in code (`src/modules/websocket/websocket.ts`), but no active registration in `src/server.ts`. Current realtime integration should target SSE only.
