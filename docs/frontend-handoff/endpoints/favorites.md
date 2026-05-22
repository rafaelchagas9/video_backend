# Favorites API Documentation

Scope: `/api/favorites/*`

## Integration notes

- All endpoints require authentication.
- Favorites are user-scoped.
- Video list/detail endpoints already expose `is_favorite`; this module is useful for dedicated favorites screens and direct toggle checks.

## Endpoints

### GET /api/favorites

- Success: `200` -> `{ success: true, data: FavoriteVideo[] }`
- Item fields:
  - `id`, `file_name`, `title`, `duration_seconds`, `added_at`, `thumbnail_url`

### POST /api/favorites

- Body:
  - `video_id` positive int
- Success: `201` -> `{ success: true, message }`
- Errors: `400`, `401`, `404`, `409`

### DELETE /api/favorites/:video_id

- Success: `200` -> `{ success: true, message }`
- Errors: `401`, `404`

### GET /api/favorites/:video_id/check

- Success: `200` -> `{ success: true, data: { is_favorite: boolean } }`

## Frontend cautions

1. Prefer optimistic toggles in UI, but reconcile with backend because `409` is possible on duplicate add.
2. Keep favorites cache synchronized with video detail/list `is_favorite` fields.
