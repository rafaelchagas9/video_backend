# Video Stats API Documentation

Scope: `/api/videos/:id/watch` and `/api/videos/:id/stats`

## Integration notes

- All endpoints require authentication.
- Stats are both per-user and aggregate.
- This module is complementary to playback and resume UX.
- Watch updates can be sent periodically while playing or on pause/exit.

## Endpoints

### POST /api/videos/:id/watch

- Params:
  - `id` positive int
- Body:
  - `watched_seconds` number > 0
  - `last_position_seconds` number >= 0 optional
- Success: `200` -> `{ success: true, data: { stats, aggregate, play_count_incremented } }`
- Errors: `400`, `401`, `404`

#### Response details

- `stats`: per-user stats for the authenticated user
- `aggregate`: combined stats for the video across users/data model
- `play_count_incremented`: boolean telling whether this update increased play count

### GET /api/videos/:id/stats

- Params:
  - `id` positive int
- Success: `200` -> `{ success: true, data: { stats, aggregate } }`
- Errors: `401`, `404`

## Per-user stats model

- `user_id`
- `video_id`
- `play_count`
- `total_watch_seconds`
- `session_watch_seconds`
- `session_play_counted`
- `last_position_seconds`
- `last_played_at`
- `last_watch_at`
- `created_at`
- `updated_at`

## Aggregate stats model

- `video_id`
- `total_play_count`
- `total_watch_seconds`
- `last_played_at`

## Frontend cautions

1. Use `last_position_seconds` for resume-play UX.
2. Avoid posting watch updates too aggressively; batch on intervals or lifecycle events.
3. `play_count_incremented` is useful if UI wants to react only to true play events rather than every progress ping.
