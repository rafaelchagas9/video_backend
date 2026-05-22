# Directories API Documentation

Scope: `/api/directories/*`

## Integration notes

- All endpoints require authentication.
- Creating a directory triggers async initial scan.
- Manual scan endpoint is fire-and-forget style (returns started, not finished).

## Endpoints

### POST /api/directories

- Body:
  - `path` string (min 1)
  - `auto_scan` boolean (default true)
  - `scan_interval_minutes` int > 0 (default 30)
- Success: `201` -> `{ success: true, data: Directory, message }`
- Errors: `400`, `401`, `409`

### GET /api/directories

- Success: `200` -> `{ success: true, data: Directory[] }`
- Errors: `401`

### GET /api/directories/:id

- Params:
  - `id` positive int
- Success: `200` -> `{ success: true, data: Directory }`
- Errors: `401`, `404`

### PATCH /api/directories/:id

- Params:
  - `id` positive int
- Body (all optional):
  - `is_active` boolean
  - `auto_scan` boolean
  - `scan_interval_minutes` int > 0
- Success: `200` -> `{ success: true, data: Directory, message }`
- Errors: `400`, `401`, `404`

### DELETE /api/directories/:id

- Params:
  - `id` positive int
- Success: `200` -> `{ success: true, message }`
- Errors: `401`, `404`

### POST /api/directories/:id/scan

- Params:
  - `id` positive int
- Success: `200` -> `{ success: true, message: "Directory scan started" }`
- Errors: `401`, `404`

### GET /api/directories/:id/stats

- Params:
  - `id` positive int
- Success: `200` -> `{ success: true, data: DirectoryStats }`
- Errors: `401`, `404`

## Shared models

- `Directory`:
  - `id`, `path`, `is_active`, `auto_scan`, `scan_interval_minutes`, `last_scan_at`, `added_at`, `updated_at`
- `DirectoryStats`:
  - `directory_id`, `total_videos`, `total_size_bytes`, `available_videos`, `unavailable_videos`
