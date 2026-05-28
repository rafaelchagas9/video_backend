# Random Video API Handoff

Scope: `GET /api/videos/random`

This endpoint now supports frontend-controlled restrictions so random selection can target a specific subset of the library instead of all available videos.

## Summary

- Auth: Required
- Method: `GET`
- Path: `/api/videos/random`
- Success: `200` -> `{ success: true, data: Video }`
- Errors:
  - `401` unauthenticated
  - `400` invalid query values
  - `404` no video matched the requested subset

## What changed

Previously, this endpoint returned a random available video.

It now supports:

- metadata completeness filters
- availability and directory filters
- creator, tag, and studio allowlists
- per-user play count filters

This makes the endpoint usable for:

- discovery surfaces like "show me something unwatched"
- tagging workflows like "give me a video without creators"
- cleanup flows like "find a random untagged video"
- scoped discovery like "show a random video from these creators"

## Query parameters

All parameters are optional.

- `directory_id` positive integer
  - Restrict random selection to one watched directory.
- `include_hidden` boolean, default `false`
  - When `false`, random selection only uses available videos.
  - When `true`, unavailable videos may be included unless `isAvailable` is also set.
- `isAvailable` boolean
  - Explicit availability filter.
- `hasTags` boolean
  - `true` means only videos with at least one linked tag.
  - `false` means only videos with no linked tags.
- `hasCreator` boolean
  - `true` means only videos with at least one linked creator.
  - `false` means only videos with no linked creators.
- `hasStudio` boolean
  - `true` means only videos with at least one linked studio.
  - `false` means only videos with no linked studios.
- `hasRating` boolean
  - `true` means only videos with at least one rating.
  - `false` means only videos with no ratings.
- `creatorIds` comma-separated ids or array
  - Restrict to videos linked to one of the listed creators.
- `tagIds` comma-separated ids or array
  - Restrict to videos linked to one of the listed tags. Tag descendants are included, matching the list endpoint behavior.
- `studioIds` comma-separated ids or array
  - Restrict to videos linked to one of the listed studios.
- `matchMode` `any` or `all`, default `any`
  - `any` means a video may match any listed ID within each relationship type.
  - `all` means a video must have every listed ID within each relationship type.
- `minPlayCount` non-negative integer
  - Restrict to videos whose play count for the current user is at least this value.
- `maxPlayCount` non-negative integer
  - Restrict to videos whose play count for the current user is at most this value.

## Important behavior

### Per-user play count

- `minPlayCount` and `maxPlayCount` use the authenticated user's `video_stats.play_count`.
- If the user has no `video_stats` row for a video, backend treats that video as play count `0`.
- This means `maxPlayCount=0` is the correct way to ask for unwatched videos.

### Presence filters

- `hasTags=false` means no entries in `video_tags` for that video.
- `hasCreator=false` means no entries in `video_creators`.
- `hasStudio=false` means no entries in `video_studios`.
- `hasRating=false` means no entries in `ratings`.

### Relationship allowlists

- `creatorIds=1,2` means the random video must have creator `1` or `2`.
- `tagIds=3,4` means the random video must have tag `3`, tag `4`, or one of their descendant tags.
- `studioIds=5,6` means the random video must have studio `5` or `6`.
- Combining relationship types narrows the subset. For example, `creatorIds=1,2&tagIds=3` requires an allowed creator and the allowed tag.
- Use `matchMode=all` when every listed ID in each relationship type must be present.

### No-match behavior

- If the requested subset is empty, backend returns `404`.
- Frontend should treat this as a normal empty-state condition, not as a crash scenario.

## Recommended frontend use cases

### 1. Discovery tab: unwatched content

Use:

```http
GET /api/videos/random?maxPlayCount=0
```

UI note:

- If backend returns `404`, show an empty state like "You have watched everything in this subset."

### 2. Random video for tagging creators

Use:

```http
GET /api/videos/random?hasCreator=false
```

### 3. Random video for tagging studios

Use:

```http
GET /api/videos/random?hasStudio=false
```

### 4. Random untagged video

Use:

```http
GET /api/videos/random?hasTags=false
```

### 5. Random metadata triage target

Use:

```http
GET /api/videos/random?hasCreator=false&hasTags=false&hasStudio=false
```

Note:

- Combining several `false` filters makes the subset narrower.
- Expect more `404` responses when the library is mostly organized.

### 6. Directory-scoped discovery

Use:

```http
GET /api/videos/random?directory_id=12&maxPlayCount=0
```

Useful for:

- category-specific discovery
- source-specific onboarding flows
- folder-based moderation queues

### 7. Creator-scoped discovery

Use:

```http
GET /api/videos/random?creatorIds=4,9&maxPlayCount=0
```

### 8. Studio and tag scoped discovery

Use:

```http
GET /api/videos/random?studioIds=2&tagIds=6,7
```

## Response shape

The endpoint returns the standard `Video` detail object used by the videos module.

Common fields:

- `id`
- `file_path`
- `file_name`
- `directory_id`
- `file_size_bytes`
- `duration_seconds`
- `width`
- `height`
- `codec`
- `bitrate`
- `fps`
- `audio_codec`
- `title`
- `description`
- `themes`
- `is_available`
- `last_verified_at`
- `indexed_at`
- `created_at`
- `updated_at`
- `thumbnail_id`
- `thumbnail_url`
- `is_favorite`

Example:

```json
{
  "success": true,
  "data": {
    "id": 1842,
    "file_path": "/library/source-a/example.mp4",
    "file_name": "example.mp4",
    "directory_id": 12,
    "file_size_bytes": 842199113,
    "file_hash": "abc123",
    "duration_seconds": 512.4,
    "width": 1920,
    "height": 1080,
    "codec": "h264",
    "bitrate": 8021453,
    "fps": 29.97,
    "audio_codec": "aac",
    "title": null,
    "description": null,
    "themes": null,
    "is_available": true,
    "last_verified_at": "2026-05-24T18:11:37.000Z",
    "indexed_at": "2026-05-23T10:05:12.000Z",
    "created_at": "2026-05-23T10:05:12.000Z",
    "updated_at": "2026-05-23T10:05:12.000Z",
    "thumbnail_id": 1842,
    "thumbnail_url": "/api/thumbnails/1842",
    "is_favorite": false
  }
}
```

## Frontend implementation notes

- This endpoint is ideal for action buttons like "Surprise me", "Find something to tag", or "Give me an unwatched video".
- Do not assume the same filter set will always return a result.
- Treat `404` as an empty filtered subset and keep the user in flow.
- Keep the selected filter preset visible in UI so the random result feels explainable.
- If the frontend already has reusable video filter state, these parameters should fit naturally beside the list page's presence filters.

## Suggested preset definitions

Frontend can model preset buttons around these query combinations:

- `unwatched`: `maxPlayCount=0`
- `needs_creators`: `hasCreator=false`
- `needs_tags`: `hasTags=false`
- `needs_studios`: `hasStudio=false`
- `needs_any_metadata`: `hasCreator=false&hasTags=false&hasStudio=false`
- `rated_only`: `hasRating=true`
- `allowed_creators`: `creatorIds=4,9`
- `allowed_studios_tags`: `studioIds=2&tagIds=6,7`

## Validation notes

- `minPlayCount` and `maxPlayCount` must be integers `>= 0`.
- If `minPlayCount > maxPlayCount`, backend returns `400`.
- `creatorIds`, `tagIds`, and `studioIds` must be positive integers.
- `matchMode` must be `any` or `all`.
- Boolean query values should be sent as `true` or `false`.

## Example fetch usage

```ts
const response = await fetch(
  "/api/videos/random?hasTags=false&maxPlayCount=0",
  {
    credentials: "include",
  },
);

if (response.status === 404) {
  return { kind: "empty" };
}

if (!response.ok) {
  throw new Error("Failed to fetch random video");
}

const payload = await response.json();
return payload.data;
```
