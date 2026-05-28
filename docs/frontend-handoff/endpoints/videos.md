# Videos API Documentation

Scope: `/api/videos/*`

This is the main frontend surface. It powers browsing, detail screens, playback, triage, bulk operations, metadata editing, and several per-video subresources.

## Integration notes

- All video endpoints require authentication.
- Main response shapes are not fully uniform across this module:
  - list returns `{ success, data, pagination }`
  - triage queue returns `{ success, ids, total }`
  - next video returns `{ success, data, meta }`
  - stream returns raw bytes, not JSON
- `is_favorite` is user-context aware.
- Streaming supports HTTP `Range` and may return `200`, `206`, `410`, or `416`.
- The frontend should use a dedicated API client/store layer for this module because the filter surface is large.
- List/detail endpoints support include-based enrichment for common related data.

## Core video model

Returned by detail/list/random/verify/refresh endpoints.

- `id` number
- `file_path` string
- `file_name` string
- `directory_id` number
- `file_size_bytes` number
- `file_hash` string | null
- `duration_seconds` number | null
- `width` number | null
- `height` number | null
- `codec` string | null
- `bitrate` number | null
- `fps` number | null
- `audio_codec` string | null
- `title` string | null
- `description` string | null
- `themes` string | null
- `is_available` boolean
- `last_verified_at` string | null
- `indexed_at` string
- `created_at` string
- `updated_at` string
- `thumbnail_id` number | null | optional
- `thumbnail_url` string | null | optional
- `thumbnail_base64` string | null | optional
- `is_favorite` boolean
- `collection` object | null | optional
- `collection_neighbors` object | null | optional
- `creators` Creator[] | optional
- `tags` Tag[] | optional
- `studios` Studio[] | optional

## 1) Listing and discovery

### GET /api/videos

Paginated listing with extensive filtering.

#### Query

- Pagination and sorting
  - `page` positive int, default `1`
  - `limit` positive int <= `100`, default `20`
  - `sort` one of:
    - `created_at`
    - `file_name`
    - `duration_seconds`
    - `file_size_bytes`
    - `indexed_at`
    - `width`
    - `height`
    - `bitrate`
    - `fps`
  - `order` = `asc | desc`, default `desc`
- Basic filters
  - `directory_id` positive int
  - `search` string
  - `include_hidden` boolean, default `false`
- Resolution filters
  - `minWidth`, `maxWidth`
  - `minHeight`, `maxHeight`
- File size filters (bytes)
  - `minFileSize`, `maxFileSize`
- Duration filters (seconds)
  - `minDuration`, `maxDuration`
- Codec filters
  - `codec`
  - `audioCodec`
- Bitrate filters
  - `minBitrate`, `maxBitrate`
- FPS filters
  - `minFps`, `maxFps`
- Rating filters
  - `minRating`, `maxRating` (1..5)
- Relationship filters
  - `creatorIds` comma-separated ids or array
  - `tagIds` comma-separated ids or array
  - `studioIds` comma-separated ids or array
  - `matchMode` = `any | all`, default `any`
- Presence filters
  - `isFavorite`
  - `hasThumbnail`
  - `isAvailable`
  - `hasTags`
  - `hasCreator`
  - `hasStudio`
  - `hasRating`
- Includes
  - `collection`
  - `creators`
  - `tags`
  - `studios`
  - comma-separated combinations are supported

#### Success

- `200` -> `{ success: true, data: Video[], pagination: { page, limit, total, totalPages } }`

#### Errors

- `401`
- `400` validation errors when min > max or invalid query values

#### Frontend notes

- Query state should be centralized because many screens will reuse filters.
- `creatorIds`, `tagIds`, `studioIds` are ideal candidates for URL-driven state.
- Validation can fail when any min/max pair is inverted.
- Prefer `include=collection,creators,tags,studios` on screens that render those associations.
- Avoid unconditional includes on every generic grid because payload size increases.

### GET /api/videos/compression-suggestions

Returns candidates for conversion/downscaling.

#### Query

- `limit` positive int <= `500`, default `50`
- `offset` non-negative int, default `0`

#### Success

- `200` -> `{ success: true, data: CompressionSuggestion[], summary }`

#### Compression suggestion fields

- `video_id`, `file_name`, `file_size_bytes`
- `width`, `height`, `codec`, `bitrate`, `fps`, `duration_seconds`
- `is_favorite`
- `bytes_per_second`
- `estimated_output_bytes`
- `estimated_savings_bytes`
- `estimated_savings_percent`
- `confidence` = `high | medium | low`
- `priority_score`
- `recommended_preset`
- `recommended_preset_name`
- `reasons` string[]
- `thumbnail_id`, `thumbnail_url`

#### Summary fields

- `total_candidates`
- `total_estimated_savings_bytes`
- `avg_estimated_savings_percent`
- `historical_accuracy_note`

### GET /api/videos/random

- Success: `200` -> `{ success: true, data: Video }`
- Errors: `401`, `404`
- Query:
  - `directory_id` positive int
  - `include_hidden` boolean, default `false`
  - `isAvailable` boolean
  - `hasTags` boolean
  - `hasCreator` boolean
  - `hasStudio` boolean
  - `hasRating` boolean
  - `creatorIds` comma-separated ids or array
  - `tagIds` comma-separated ids or array
  - `studioIds` comma-separated ids or array
  - `matchMode` `any` or `all`, default `any`
  - `minPlayCount` non-negative int
  - `maxPlayCount` non-negative int
- Frontend notes:
  - Use `maxPlayCount=0` for unwatched discovery.
  - Use `creatorIds`, `tagIds`, and `studioIds` to restrict random selection to allowed relationships.
  - Use `hasCreator=false`, `hasTags=false`, or `hasStudio=false` for metadata/tagging workflows.
  - `404` means no video matched the requested subset.
  - Detailed handoff: `endpoints/videos-random.md`

### GET /api/videos/duplicates

- Success: `200` -> `{ success: true, data: DuplicateGroup[] }`

#### Duplicate group fields

- `file_hash` string
- `count` number
- `total_size_bytes` string
- `videos`: `{ id, file_name, file_path, file_size_bytes, indexed_at }[]`

## 2) Triage/navigation helpers

### GET /api/videos/next

Navigate to next or previous matching video.

#### Query

- All `GET /api/videos` filters
- Plus:
  - `currentId` positive int
  - `direction` = `next | previous`, default `next`

#### Success

- `200` -> `{ success: true, data: Video | null, meta: { remaining, total_matching, has_wrapped } }`

#### Errors

- `401`, `404`

#### Frontend notes

- `data` may be `null`; don’t assume navigation target always exists.
- `has_wrapped` is useful for UX hints in carousel/triage mode.

### GET /api/videos/triage-queue

Lightweight ID queue for client-side navigation.

#### Query

- All `GET /api/videos` filters
- Plus:
  - `queueLimit` positive int <= `1000`, default `100`
  - `queueOffset` non-negative int, default `0`

#### Success

- `200` -> `{ success: true, ids: number[], total: number }`

#### Frontend notes

- Use this for prefetch/navigation state instead of loading full objects.

## 3) Detail and lifecycle

### GET /api/videos/:id

- Params: `id` positive int
- Query:
  - `include=collection`
  - `include=collection_neighbors`
  - `include=creators`
  - `include=tags`
  - `include=studios`
  - comma-separated combinations are supported
- Success: `200` -> `{ success: true, data: Video }`
- Errors: `401`, `404`

#### Frontend notes

- Recommended default for detail/player pages:
  - `include=collection,collection_neighbors,creators,tags,studios`
- This avoids the common fan-out pattern of separately loading creators, tags, studios, and collection context after the base video request.

### PATCH /api/videos/:id

- Params: `id` positive int
- Body:
  - `title` string optional
  - `description` string optional
  - `themes` string optional
- Success: `200` -> `{ success: true, data: Video, message }`
- Errors: `400`, `401`, `404`

### DELETE /api/videos/:id

- Success: `200` -> `{ success: true, message }`
- Errors: `401`, `404`
- Important: removes DB record, not the underlying video file.

### POST /api/videos/:id/verify

- Success: `200` -> `{ success: true, data: Video, message }`
- Errors: `401`, `404`
- Message varies based on actual file presence.

### POST /api/videos/:id/refresh

- Re-extracts technical metadata and regenerates thumbnail.
- Success: `200` -> `{ success: true, data: Video, message }`
- Errors: `400`, `401`, `404`

## 4) Streaming

### GET /api/videos/:id/stream

Raw media stream with `Range` support.

#### Request headers

- Optional `Range: bytes=...`

#### Success

- `200` full stream
- `206` partial content when range request is valid

#### Response headers

- `Content-Type` based on file extension
- `Content-Length`
- `Accept-Ranges: bytes`
- `Content-Range` on partial responses
- `Access-Control-Expose-Headers: Content-Range, Accept-Ranges, Content-Length`

#### Important backend behavior

- Large range requests may be capped by backend max chunk size.
- Invalid range produces `416 Range Not Satisfiable`.
- Missing/unavailable underlying file produces `410`.

#### Frontend notes

- Browser/native player should handle `206` automatically.
- Custom player integrations must preserve `credentials: "include"`.
- Avoid building JSON expectations around this route.

## 5) Bulk operations

### POST /api/videos/bulk/delete

- Body:
  - `ids` positive int[] (min 1)
- Success: `200` -> `{ success: true, message }`

### POST /api/videos/bulk/creators

- Body:
  - `videoIds` positive int[]
  - `creatorIds` positive int[]
  - `action` = `add | remove`
- Success: `200` -> `{ success: true, message }`

### POST /api/videos/bulk/tags

- Body:
  - `videoIds` positive int[]
  - `tagIds` positive int[]
  - `action` = `add | remove`

### POST /api/videos/bulk/studios

- Body:
  - `videoIds` positive int[]
  - `studioIds` positive int[]
  - `action` = `add | remove`

### POST /api/videos/bulk/favorites

- Body:
  - `videoIds` positive int[]
  - `isFavorite` boolean

### POST /api/videos/bulk/conditional-apply

- Body:
  - `filter`: same shape as `GET /api/videos` query, optional
  - `actions`:
    - `addCreatorIds` optional
    - `removeCreatorIds` optional
    - `addTagIds` optional
    - `removeTagIds` optional
    - `addStudioIds` optional
    - `removeStudioIds` optional

- Success: `200` -> `{ success: true, data: { matched, affected, errors, details } }`

#### Conditional apply details

- `creators_added`
- `creators_removed`
- `tags_added`
- `tags_removed`
- `studios_added`
- `studios_removed`

## 6) Per-video associations and metadata

Important:

- `creators`, `tags`, `studios`, and `collection` can now be embedded through `include` on `/api/videos` and `/api/videos/:id`.
- Keep the separate endpoints below for edit flows, focused refreshes, or screens that intentionally load one relation at a time.

### Creators

- `GET /api/videos/:id/creators`
  - Success: `{ success: true, data: Creator[] }`
- `POST /api/videos/:id/creators`
  - Body: `{ creator_id }`
  - Success: `201` -> `{ success: true, message }`
  - Errors: `400`, `401`, `404`, `409`
- `DELETE /api/videos/:id/creators/:creator_id`
  - Success: `{ success: true, message }`

### Tags

- `GET /api/videos/:id/tags`
  - Success: `{ success: true, data: Tag[] }`
- `POST /api/videos/:id/tags`
  - Body: `{ tag_id }`
  - Success: `201` -> `{ success: true, message }`
  - Errors: `400`, `401`, `404`, `409`
- `DELETE /api/videos/:id/tags/:tag_id`
  - Success: `{ success: true, message }`

### Custom metadata

- `GET /api/videos/:id/metadata`
  - Success: `{ success: true, data: { key, value }[] }`
- `POST /api/videos/:id/metadata`
  - Body:
    - `key` string 1..255
    - `value` string <= 10000
  - Success: `201` -> `{ success: true, message }`
- `DELETE /api/videos/:id/metadata/:key`
  - Success: `{ success: true, message }`

### Ratings

- `GET /api/videos/:id/ratings`
  - Success: `{ success: true, data: Rating[], average: number | null }`
- `POST /api/videos/:id/ratings`
  - Body:
    - `rating` int 1..5
    - `comment` string <= 2000 optional
  - Success: `201` -> `{ success: true, data: Rating, message }`

### Bookmarks

- `GET /api/videos/:id/bookmarks`
  - Returns bookmarks for authenticated user only
  - Success: `{ success: true, data: Bookmark[] }`
- `POST /api/videos/:id/bookmarks`
  - Body:
    - `timestamp_seconds` number >= 0
    - `name` string 1..255
    - `description` string <= 2000 optional
  - Success: `201` -> `{ success: true, data: Bookmark, message }`

### Studios

- `GET /api/videos/:id/studios`
  - Success: `{ success: true, data: Studio[] }`
- `POST /api/videos/:id/studios/:studio_id`
  - Success: `{ success: true, message }`
- `DELETE /api/videos/:id/studios/:studio_id`
  - Success: `{ success: true, message }`

## 7) Suggested frontend implementation order

1. `GET /api/videos`
2. `GET /api/videos/:id`
3. `GET /api/videos/:id/stream`
4. `GET /api/videos/next`
5. `GET /api/videos/triage-queue`
6. `POST /api/videos/:id/bookmarks` and `GET /api/videos/:id/bookmarks`
7. `GET/POST` ratings
8. creators/tags/studios associations
9. bulk operations and duplicates/compression suggestions

## 8) Frontend cautions

1. Keep filter parsing/serialization centralized.
2. Treat list state and triage queue state as related but separate caches.
3. Don’t assume every success payload uses `data` only; triage queue and next video are special.
4. Stream route is binary and credentialed; player integration must preserve cookies.
5. `is_available` can change after verify/refresh and should affect playback UI.
6. Bookmarks are user-scoped even though video detail itself is global.
7. Duplicates route returns `total_size_bytes` as string, not number.
