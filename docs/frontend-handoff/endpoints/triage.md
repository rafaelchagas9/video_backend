# Triage API Documentation

Scope: `/api/users/triage-*` and `/api/users/triage/*`

## Integration notes

- All endpoints require authentication.
- These endpoints support resume/progress tracking and bulk triage operations.
- Triage works closely with the Videos module (`/api/videos/next`, `/api/videos/triage-queue`).

## Endpoints

### POST /api/users/triage-progress

- Body:
  - `filterKey` string 1..2000
  - `lastVideoId` positive int
  - `processedCount` non-negative int
  - `totalCount` positive int optional
- Success: `200` -> `{ success: true, message: "Progress saved" }`

### GET /api/users/triage-progress

- Query:
  - `filterKey` string 1..2000
- Success: `200` -> `{ success: true, data: Progress | null }`

#### Progress model

- `filter_key`
- `last_video_id`
- `processed_count`
- `total_count`
- `updated_at`

### POST /api/users/triage/bulk-actions

- Body:
  - `videoIds` positive int[] (1..1000)
  - `actions`:
    - `addCreatorIds` optional
    - `removeCreatorIds` optional
    - `addTagIds` optional
    - `removeTagIds` optional
    - `addStudioIds` optional
    - `removeStudioIds` optional
- Success: `200` -> `{ success: true, data: { processed, errors, details } }`

### GET /api/users/triage/statistics

- Success: `200` -> `{ success: true, data: TriageStatistics }`

#### Triage statistics fields

- `total_untagged_videos`
- `total_videos`
- `tagged_percentage`
- `recent_progress`
  - `last_24h_processed`
  - `last_7d_processed`
  - `avg_daily_rate`
- `filter_breakdown[]`
  - `filter_key`, `total`, `processed_count`, `percentage`
- `top_directories[]`
  - `directory_id`, `path`, `untagged_count`

## Frontend cautions

1. `filterKey` should be deterministic from the active triage filter state.
2. Save progress opportunistically during triage, not only on explicit exit.
3. Bulk-actions UI should surface partial failures using returned `errors` and detail counters.
