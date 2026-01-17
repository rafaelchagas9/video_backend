# Frontend Integration: Video Stats + Compression Suggestions

## Auth

- All endpoints require authenticated session cookie (`session_id`).
- WebSocket `/ws` uses the same cookie for user identity.

## REST API

### Record watch progress

- **POST** `/api/videos/:id/watch`
- **Body**
  - `watched_seconds` (number, required) — delta since last update.
  - `last_position_seconds` (number, optional).
- **Response**
  - `data.stats`: per-user stats (play_count, total_watch_seconds, last_played_at, etc.).
  - `data.aggregate`: summed stats across all users.
  - `data.play_count_incremented`: true when threshold reached.

### Fetch watch stats

- **GET** `/api/videos/:id/stats`
- **Response**
  - `data.stats`: per-user stats.
  - `data.aggregate`: summed stats across all users.

### Compression suggestions

- **GET** `/api/videos/compression-suggestions`
- **Query**
  - `limit` (default 50)
  - `offset` (default 0)
- **Response**
  - `data[]`:
    - `video_id`, `file_name`, `file_size_bytes`, `width`, `height`, `codec`, `bitrate`, `fps`, `duration_seconds`
    - `total_play_count`, `total_watch_seconds`, `last_played_at`
    - `technical_score`, `usage_score`
    - `recommended_actions` (array: `reencode_av1`, `downscale_1080p`)
    - `reasons` (array of reason codes)

### Settings

- **GET** `/api/settings`
- **PATCH** `/api/settings`
  - **Body** `settings` object (key → value)
- Relevant keys:
  - `min_watch_seconds`
  - `short_video_watch_seconds`
  - `short_video_duration_seconds`
  - `downscale_inactive_days`
  - `watch_session_gap_minutes`
  - `max_suggestions`

## WebSocket

- **URL** `/ws`
- **Client → Server message**
  - `type`: `video:watch`
  - `payload`: `{ video_id, watched_seconds, last_position_seconds }`

## Tips / Attention Points

- Use **delta** `watched_seconds` (e.g., 10s heartbeat), not cumulative.
- Play count increments only once per session after threshold is met.
- If no WebSocket, you can still call the REST endpoint for updates.
