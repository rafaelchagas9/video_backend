# Backend API Request: Triage Mode Support

> **Purpose**: This document outlines the backend changes required to support the new Triage Mode and improved filtering features in the frontend.

---

## 1. New Endpoint: Get Next Video

**Purpose**: Navigate to the next video matching filter criteria without fetching the full list.

### `GET /videos/next`

#### Query Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `currentId` | integer | Yes | ID of the current video |
| `direction` | string | No | `next` (default) or `previous` |
| `hasTags` | boolean | No | Filter: video has at least one tag |
| `hasCreator` | boolean | No | Filter: video has at least one creator |
| `hasStudio` | boolean | No | Filter: video has at least one studio |
| `directoryId` | integer | No | Limit to specific directory |
| `sort` | string | No | Sort field (default: `created_at`) |
| `order` | string | No | `asc` or `desc` (default: `desc`) |

> **Note**: All existing `/videos` filter params should also be supported here for consistency.

#### Response

```json
{
  "success": true,
  "data": {
    "id": 1234,
    "file_name": "video.mp4",
    "title": "Example Video",
    "thumbnail_url": "/api/thumbnails/1234"
  },
  "meta": {
    "remaining": 42,
    "total_matching": 247
  }
}
```

If no next video exists:
```json
{
  "success": true,
  "data": null,
  "meta": {
    "remaining": 0,
    "total_matching": 247
  }
}
```

---

## 2. Filter Enhancements on `GET /videos`

### New Parameters Needed

| Parameter | Type | Description |
|-----------|------|-------------|
| `hasTags` | boolean | `true` = has tags, `false` = no tags |
| `hasCreator` | boolean | `true` = has creator, `false` = no creator |
| `hasStudio` | boolean | `true` = has studio, `false` = no studio |
| `hasRating` | boolean | `true` = has rating, `false` = no rating |

> **Rationale**: Currently we have `tagIds` but no way to filter for "videos with NO tags". The `hasTags=false` filter fills this gap.

---

## 3. New Endpoint: Get Triage Queue IDs

**Purpose**: Fetch a lightweight list of video IDs for client-side navigation (pagination optional).

### `GET /videos/triage-queue`

#### Query Parameters

All filter parameters from `/videos`, plus:

| Parameter | Type | Description |
|-----------|------|-------------|
| `limit` | integer | Max IDs to return (default: 100) |
| `offset` | integer | Starting position (default: 0) |

#### Response

```json
{
  "success": true,
  "data": {
    "ids": [123, 456, 789, ...],
    "total": 247
  }
}
```

> **Use Case**: Frontend fetches first 100 IDs, enables keyboard navigation. When user reaches ID #90, prefetch next batch.

---

## 4. Triage Progress Tracking (Optional Enhancement)

**Purpose**: Server-side persistence of triage progress per user.

### `POST /users/triage-progress`

#### Request Body

```json
{
  "filterKey": "untagged",
  "lastVideoId": 1234,
  "processedCount": 42
}
```

### `GET /users/triage-progress`

#### Query Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `filterKey` | string | e.g., `untagged`, `no_creator` |

#### Response

```json
{
  "success": true,
  "data": {
    "filterKey": "untagged",
    "lastVideoId": 1234,
    "processedCount": 42,
    "updatedAt": "2026-01-10T10:00:00Z"
  }
}
```

> **Note**: This is optional. Frontend can use `localStorage` as fallback, but server-side sync is better for multi-device users.

---

## Priority Order

| # | Endpoint/Feature | Priority | Reason |
|---|------------------|----------|--------|
| 1 | `hasTags`, `hasCreator`, `hasStudio` filters on `/videos` | 🔴 High | Enables Smart Filters in Library immediately |
| 2 | `GET /videos/next` | 🔴 High | Core navigation for Triage Mode |
| 3 | `GET /videos/triage-queue` | 🟡 Medium | Optimizes prefetching, nice-to-have |
| 4 | Triage Progress endpoints | 🟢 Low | Can use localStorage initially |

---

## Existing Filters Reference

For reference, here are the filters already supported on `GET /videos`:

- `minWidth`, `maxWidth`, `minHeight`, `maxHeight`
- `minFileSize`, `maxFileSize`
- `minDuration`, `maxDuration`
- `codec`, `audioCodec`
- `minBitrate`, `maxBitrate`
- `minFps`, `maxFps`
- `minRating`, `maxRating`
- `creatorIds` (array)
- `tagIds` (array)
- `studioIds` (array)
- `matchMode` (`ALL` | `ANY`)
- `isFavorite`
- `hasThumbnail`
- `isAvailable`

---

## Questions for Backend Team

1. For `GET /videos/next`, should we support wrapping (i.e., after last video, go back to first)?
2. Should the `remaining` count in the response be exact or an estimate for performance?
3. Any concerns about adding boolean filters (`hasTags`, `hasCreator`, etc.) to the existing index?
