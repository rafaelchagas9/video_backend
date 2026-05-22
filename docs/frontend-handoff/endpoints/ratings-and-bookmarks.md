# Ratings and Bookmarks API Documentation

Scope:

- `/api/ratings/*`
- `/api/bookmarks/*`

## Integration notes

- All endpoints require authentication.
- Create/list rating and bookmark operations are under `/api/videos/:id/*` in Videos routes; this file covers dedicated update/delete endpoints.

## Ratings

### PATCH /api/ratings/:id

- Params: `id` positive int
- Body: `updateRatingSchema` (rating update payload)
- Success: `200` -> `{ success: true, data: Rating, message }`
- Errors: `400`, `401`, `404`

### DELETE /api/ratings/:id

- Params: `id` positive int
- Success: `200` -> `{ success: true, message }`
- Errors: `401`, `404`

### Rating model

- `id` number
- `video_id` number
- `rating` int (1..5)
- `comment` string | null
- `rated_at` string

## Bookmarks

### PATCH /api/bookmarks/:id

- Params: `id` positive int
- Body: `updateBookmarkSchema`
- Success: `200` -> `{ success: true, data: Bookmark, message }`
- Errors: `401`, `404`
- Ownership note:
  - Backend validates bookmark against authenticated user.

### DELETE /api/bookmarks/:id

- Params: `id` positive int
- Success: `200` -> `{ success: true, message }`
- Errors: `401`, `404`
- Ownership note:
  - Backend deletes only for authenticated owner.

### Bookmark model

- `id` number
- `video_id` number
- `user_id` number
- `timestamp_seconds` number
- `name` string
- `description` string | null
- `created_at` string
- `updated_at` string
