# Playlists API Documentation

Scope: `/api/playlists/*`

## Integration notes

- All endpoints require authentication.
- Playlists are user-owned.
- Playlist video ordering is explicit and important for UI.
- `thumbnail_url` may be present on playlist and playlist video items.

## Endpoints

### POST /api/playlists

- Body:
  - `name` string 1..255
  - `description` string <= 2000 optional
- Success: `201` -> `{ success: true, data: Playlist, message }`

### GET /api/playlists

- Success: `200` -> `{ success: true, data: Playlist[] }`

### GET /api/playlists/:id

- Success: `200` -> `{ success: true, data: Playlist }`
- Errors: `401`, `404`

### PATCH /api/playlists/:id

- Body:
  - `name` optional
  - `description` optional, nullable
- Success: `200` -> `{ success: true, data: Playlist, message }`

### DELETE /api/playlists/:id

- Success: `200` -> `{ success: true, message }`

### GET /api/playlists/:id/videos

- Success: `200` -> `{ success: true, data: PlaylistVideo[] }`
- Video item fields:
  - `id`, `file_name`, `title`, `duration_seconds`, `position`, `thumbnail_id`, `thumbnail_url`

### POST /api/playlists/:id/videos/bulk

- Body:
  - `videoIds` positive int[]
  - `action` = `add | remove`
- Success: `200` -> `{ success: true, message }`
- Note: for `add`, videos are appended to the end.

### POST /api/playlists/:id/videos

- Body:
  - `video_id` positive int
  - `position` int >= 0 optional
- Success: `201` -> `{ success: true, message }`
- Errors: `400`, `401`, `404`, `409`

### DELETE /api/playlists/:id/videos/:video_id

- Success: `200` -> `{ success: true, message }`

### PATCH /api/playlists/:id/videos/reorder

- Body:
  - `videos: [{ video_id, position }]`
- Success: `200` -> `{ success: true, message }`

## Frontend cautions

1. Treat playlist ordering as authoritative backend state.
2. Reorder UI should send full position payload, not just pairwise moves.
3. Playlist ownership is user-scoped, so cache should be auth-user specific.
