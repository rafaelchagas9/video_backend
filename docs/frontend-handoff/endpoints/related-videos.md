# Related Videos API

Scope: `/api/videos/:id/related`

This feature returns explainable, cached related-video recommendations for a source video. It is designed for exploration: results should feel connected to the current video, but not simply repeat the exact same item cluster.

## Behavior

- Requires authentication.
- Returns available videos related to the source video.
- Uses cached scores from `video_related_scores`.
- Automatically computes scores on first request or when cache is stale.
- `refresh=true` forces recomputation.
- Source video is never returned in its own related list.
- Watched/recently watched videos are included, but heavily penalized.
- Face recognition is not part of v1.
- Title and file-name text are not used because titles may be unreliable.

## Ranking Signals

High influence:

- Shared tags.
- Shared tag families through parent/child relationships.
- Shared themes from `video.themes`.

Medium influence:

- Shared creators.
- Shared studios.
- Same playlists.
- Favorites.
- Ratings.

Low influence:

- Similar duration.
- Same directory.

Penalties:

- Previously watched videos.
- Recently watched videos receive a stronger penalty.

## Endpoint

### GET /api/videos/:id/related

Returns related videos for a source video.

#### Path Params

- `id` positive integer, required. Source video id.

#### Query Params

- `limit` positive integer, max `100`, default `12`.
- `refresh` boolean, default `false`.

Examples:

```http
GET /api/videos/123/related
GET /api/videos/123/related?limit=20
GET /api/videos/123/related?limit=12&refresh=true
```

#### Request Body

No request body.

#### Success Response

Status: `200`

```json
{
  "success": true,
  "data": [
    {
      "video": {
        "id": 763,
        "file_path": "/media/example.mkv",
        "file_name": "example.mkv",
        "directory_id": 1,
        "file_size_bytes": 676850508,
        "file_hash": "96bf2622804196a3e2472f27a4837980",
        "duration_seconds": 890.44,
        "width": 1920,
        "height": 1080,
        "codec": "av1",
        "bitrate": 6081043,
        "fps": 29.97,
        "audio_codec": "opus",
        "title": "",
        "description": null,
        "themes": "cyberpunk, neon",
        "is_available": true,
        "last_verified_at": "2026-05-19T20:49:25.777Z",
        "indexed_at": "2026-01-09T22:31:05.000Z",
        "created_at": "2026-01-09T22:31:05.000Z",
        "updated_at": "2026-02-24T13:13:12.185Z",
        "is_favorite": false,
        "thumbnail_id": 762,
        "thumbnail_url": "/api/thumbnails/762/image"
      },
      "score": 51,
      "reasons": [
        "shared-tags:2",
        "similar-duration",
        "same-directory",
        "unwatched"
      ]
    }
  ],
  "meta": {
    "computed_at": "2026-05-20T06:31:21.035Z",
    "refreshed": false,
    "candidate_count": 496
  }
}
```

#### Response Fields

- `success` boolean literal `true`.
- `data` array of related-video result objects.
- `data[].video` standard video object.
- `data[].score` numeric relatedness score. Higher is more related after penalties/boosts.
- `data[].reasons` string array explaining why the video was ranked.
- `meta.computed_at` ISO timestamp for the latest cached computation, or `null` if no scores exist.
- `meta.refreshed` boolean indicating whether this request recomputed the cache.
- `meta.candidate_count` number of cached candidate scores for the source video.

#### Reason Strings

Current reason examples:

- `shared-tags:2`
- `shared-tag-family:3`
- `shared-themes:cyberpunk,neon`
- `shared-creators:1`
- `shared-studios:1`
- `same-playlists:1`
- `similar-duration`
- `same-directory`
- `high-rating:4.5`
- `favorite`
- `unwatched`
- `watched-penalty:-60`

Treat reason strings as display/debug hints. They are stable enough for frontend display, but the frontend should not rely on exact strings for business logic.

`shared-tags` note: this is an exact tag overlap count between source and candidate (for example both videos have `Twitch`). This is a strong relevance signal and should usually be shown as a primary explanation chip.

Tag hierarchy note: `shared-tag-family` means the videos are related through nested tags. For example, `Romance`, `Light Romance`, and `Dark Romance` all relate through the same tag family, so parent-to-child, child-to-parent, and sibling-to-sibling tag matches can rank together.

#### Errors

- `401` unauthenticated.
- `404` source video not found.
- `400` invalid query params.

Error shape follows the existing API error format:

```json
{
  "success": false,
  "error": {
    "message": "Video not found with id: 123",
    "statusCode": 404
  }
}
```

## Frontend Recommendations

- Show related videos on the video detail/playback page.
- Default to `limit=12` for a shelf/carousel.
- Use `refresh=true` only for explicit user action or admin/debug UI; normal frontend usage should rely on cache.
- Display explanation chips from `reasons`, but keep them secondary to the thumbnail/title metadata.
- Sort order is already handled by the backend. Do not re-sort by score on the client unless there is a specific UX reason.
- If `data` is empty, show a lightweight empty state such as "No related videos yet" and optionally suggest adding tags/themes.

## TypeScript Sketch

```ts
type RelatedVideoResult = {
  video: Video;
  score: number;
  reasons: string[];
};

type RelatedVideosResponse = {
  success: true;
  data: RelatedVideoResult[];
  meta: {
    computed_at: string | null;
    refreshed: boolean;
    candidate_count: number;
  };
};
```
