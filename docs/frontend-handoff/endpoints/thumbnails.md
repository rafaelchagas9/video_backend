# Thumbnails API Documentation

Scope: thumbnail generation and image serving

## Integration notes

- All endpoints require authentication.
- Mix of JSON endpoints and binary image response.
- Thumbnail generation accepts either timestamp or percentage, but not both.

## Endpoints

### POST /api/videos/:id/thumbnails

- Body:
  - `timestamp` number >= 0 optional
  - `positionPercent` number 0..100 optional
- Constraint:
  - cannot provide both `timestamp` and `positionPercent`
- Success: `201` -> `{ success: true, data: Thumbnail, message }`
- Errors: `400`, `401`, `404`

### GET /api/videos/:id/thumbnails

- Success: `200` -> `{ success: true, data: Thumbnail[] }`

### GET /api/thumbnails/:id/image

- Success: `200` image bytes
- Content-Type:
  - `image/webp` or `image/jpeg`

### DELETE /api/thumbnails/:id

- Success: `200` -> `{ success: true, message }`

## Thumbnail model

- `id`
- `video_id`
- `file_path`
- `file_size_bytes`
- `timestamp_seconds`
- `width`
- `height`
- `generated_at`

## Frontend cautions

1. Use direct thumbnail image endpoint for rendering rather than local file assumptions.
2. Thumbnail generation is synchronous from API perspective but may still be noticeable in UX; show loading states.
