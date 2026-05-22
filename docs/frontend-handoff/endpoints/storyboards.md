# Storyboards API Documentation

Scope: storyboard generation + public preview assets

## Integration notes

- Public endpoints exist for player preview consumption (no auth required).
- Authenticated endpoints manage generation/deletion/metadata.
- SSE events emitted during generation: `storyboard:generating`, `storyboard:ready`, `storyboard:error`.

## Public endpoints

### GET /api/videos/:id/thumbnails.vtt
- Query:
  - `autogenerate` boolean (default false)
- Success: `200` text VTT
- Behavior:
  - If not generated and `autogenerate=true`, backend queues generation and still returns not-found until ready.

### GET /api/videos/:id/storyboard.jpg
### GET /api/videos/:id/storyboard.webp
- Success: `200` image bytes
- Cache headers: public, long-ish max-age

## Authenticated endpoints

### POST /api/videos/:id/storyboard
- Body optional:
  - `tileWidth` 64..512
  - `tileHeight` 36..288
  - `intervalSeconds` 1..60
- Success: `201` -> `{ success: true, data: Storyboard, message }`
- Errors: `400`, `401`, `404`, `500`

### DELETE /api/videos/:id/storyboard
- Success: `200` -> `{ success: true, message }`

### GET /api/videos/:id/storyboard
- Success: `200` -> `{ success: true, data: Storyboard }`
- Errors: includes not-found when missing

## Storyboard model

- `id`, `video_id`, `sprite_path`, `vtt_path`, `tile_width`, `tile_height`, `tile_count`, `interval_seconds`, `sprite_size_bytes`, `generated_at`
