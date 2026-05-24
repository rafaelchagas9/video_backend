# Video Collections API Documentation

Scope: `/api/video-collections/*` and collection-related includes on `/api/videos/*`

This module adds canonical ordered collections for sequels, seasons, episodes, specials, and extras.

## Integration notes

- All endpoints require authentication.
- Collections are global application data, not user-owned.
- A video can belong to at most one collection in the current backend model.
- Collection ordering is explicit backend state. Frontend should not infer order from filenames.
- For video detail and list screens, prefer `include` query params on `/api/videos` to avoid N+1 requests.
- Current include support on videos:
  - list: `collection`, `creators`, `tags`, `studios`
  - detail: `collection`, `collection_neighbors`, `creators`, `tags`, `studios`

## Core models

### VideoCollection

- `id` number
- `title` string
- `kind` = `movie_series | tv_series | mini_series | anthology | other`
- `description` string | null
- `release_year` number | null
- `external_ids_json` string | null
- `entry_count` number | optional
- `created_at` string
- `updated_at` string

### VideoCollectionEntry

- `id` number
- `collection_id` number
- `video_id` number
- `entry_kind` = `movie | episode | special | extra`
- `sequence_number` number | null
- `season_number` number | null
- `episode_number` number | null
- `episode_part` number | null
- `absolute_number` number | null
- `display_title_override` string | null
- `created_at` string
- `updated_at` string
- `video` optional
  - `id` number
  - `file_name` string
  - `title` string | null
  - `thumbnail_id` number | null
  - `thumbnail_url` string | null
  - `is_available` boolean

### Video collection include payload

Returned inside `Video.collection` when requested via `/api/videos`.

- `entry_id` number
- `collection_id` number
- `title` string
- `kind` = `movie_series | tv_series | mini_series | anthology | other`
- `description` string | null
- `release_year` number | null
- `entry`
  - `id`
  - `collection_id`
  - `video_id`
  - `entry_kind`
  - `sequence_number`
  - `season_number`
  - `episode_number`
  - `episode_part`
  - `absolute_number`
  - `display_title_override`
  - `created_at`
  - `updated_at`

### Video collection neighbors payload

Returned inside `Video.collection_neighbors` when requested via `/api/videos/:id`.

- `previous` object | null
- `next` object | null

Neighbor item fields:

- `video_id`
- `entry_id`
- `title`
- `file_name`
- `display_title_override`
- `sequence_number`
- `season_number`
- `episode_number`
- `episode_part`
- `absolute_number`
- `thumbnail_id`
- `thumbnail_url`

## Collection endpoints

### POST /api/video-collections

Create a collection.

#### Body

- `title` string, required, `1..255`
- `kind` required
  - `movie_series`
  - `tv_series`
  - `mini_series`
  - `anthology`
  - `other`
- `description` string | null optional
- `release_year` number | null optional
- `external_ids_json` string | null optional

#### Success

- `201` -> `{ success: true, data: VideoCollection, message }`

#### Errors

- `400`, `401`

### GET /api/video-collections

List all collections.

#### Success

- `200` -> `{ success: true, data: VideoCollection[] }`

### GET /api/video-collections/:id

Get one collection.

#### Success

- `200` -> `{ success: true, data: VideoCollection }`

#### Errors

- `401`, `404`

### PATCH /api/video-collections/:id

Update collection metadata.

#### Body

All create fields are optional.

#### Success

- `200` -> `{ success: true, data: VideoCollection, message }`

#### Errors

- `400`, `401`, `404`

### DELETE /api/video-collections/:id

Delete a collection and its entries.

#### Success

- `200` -> `{ success: true, message }`

#### Errors

- `401`, `404`

## Entry endpoints

### GET /api/video-collections/:id/entries

Get ordered entries for a collection.

#### Success

- `200` -> `{ success: true, data: VideoCollectionEntry[] }`

#### Frontend notes

- The returned order is authoritative.
- Use this for collection detail pages, season views, and reorder screens.

### POST /api/video-collections/:id/entries

Add one video to a collection.

#### Body

- `video_id` positive int, required
- `entry_kind` required
  - `movie`
  - `episode`
  - `special`
  - `extra`
- `sequence_number` int >= 1 | null optional
- `season_number` int >= 0 | null optional
- `episode_number` int >= 1 | null optional
- `episode_part` int >= 1 | null optional
- `absolute_number` int >= 1 | null optional
- `display_title_override` string | null optional

#### Validation notes

- `season_number` and `episode_number` must be provided together.
- A video can only be added once, and only to one collection.
- Sequence conflicts or episode coordinate conflicts return `409`.

#### Success

- `201` -> `{ success: true, data: [VideoCollectionEntry] }`

#### Errors

- `400`, `401`, `404`, `409`

### PATCH /api/video-collections/:id/entries/reorder

Update existing ordering and episodic coordinates.

#### Body

- `entries: Array<{ video_id, sequence_number?, season_number?, episode_number?, episode_part?, absolute_number? }>`

#### Success

- `200` -> `{ success: true, data: VideoCollectionEntry[] }`

#### Errors

- `400`, `401`, `404`, `409`

#### Frontend notes

- Send the complete ordering payload for the set being edited.
- Treat backend conflicts as real data problems, not transient client issues.
- Good UX is optimistic local reorder followed by full replacement from server response.

### DELETE /api/video-collections/:id/entries/:video_id

Remove one video from a collection.

#### Success

- `200` -> `{ success: true, message }`

#### Errors

- `401`, `404`

## Video endpoint additions

These are the main optimizations for frontend.

### GET /api/videos?include=...

Supported values:

- `collection`
- `creators`
- `tags`
- `studios`

Comma-separated combinations are supported.

Examples:

- `/api/videos?include=collection`
- `/api/videos?include=collection,creators,tags,studios`

#### Recommended use cases

- Video grid/list rows that need sequence badges
- Video cards that need “part of series” indicators
- Search/filter screens that should show collection context without extra calls
- List screens that also render creators, tags, or studios without per-row follow-up calls

#### Frontend notes

- Prefer this over fetching `/api/video-collections/:id/entries` per row.
- Prefer this over separately calling `/api/videos/:id/creators`, `/api/videos/:id/tags`, and `/api/videos/:id/studios` for each rendered row.
- Request it only on screens that actually render collection context.
- Cache list results by the full query string because `include=` changes payload shape.

### GET /api/videos/:id?include=...

Adds:

- `collection`
- `collection_neighbors`
- `creators`
- `tags`
- `studios`

Examples:

- `/api/videos/:id?include=collection,collection_neighbors`
- `/api/videos/:id?include=collection,collection_neighbors,creators,tags,studios`

#### Recommended use cases

- Video detail pages
- Player screens with previous/next episode or sequel navigation
- Breadcrumbs like `Series > Season 2 > Episode 4`
- Metadata sidebars that show creators, tags, and studios

#### Frontend notes

- This should be the default detail request for any screen that shows narrative context.
- This should also be the default detail request when the page renders creators, tags, and studios.
- If `collection` is `null`, the video is standalone.
- If `collection_neighbors.next` or `.previous` is `null`, the video is at the boundary of the collection.

## Suggested frontend implementation order

1. Add API client methods for `/api/video-collections`.
2. Extend the shared `Video` type to support optional `collection`, `collection_neighbors`, `creators`, `tags`, and `studios`.
3. Update video detail fetches to request `include=collection,collection_neighbors,creators,tags,studios`.
4. Update collection-aware list screens to request `include=collection` or `include=collection,creators,tags,studios` only where needed.
5. Build collection CRUD UI.
6. Build collection entry management UI with explicit ordering and episodic metadata editing.

## Suggested UI surfaces

- Collection detail page
- Create/edit collection dialog
- “Add to collection” action from video detail or bulk actions
- Reorder/manage entries view
- Video detail previous/next navigation within a collection
- Sequence badges in list or detail cards

## Frontend cautions

1. Do not infer season/episode/sequence values from file names.
2. Do not assume every collection uses `sequence_number`; episodic entries may rely on `season_number` and `episode_number`.
3. Do not assume neighbors exist.
4. Avoid over-fetching large include combinations on every generic list screen if the UI does not render them.
5. Handle `409` as a user-correctable conflict state, especially during reorder/edit flows.
