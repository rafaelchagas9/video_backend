# Statistics API Documentation

All statistics endpoints are authenticated and require a valid session cookie.

**Base Path:** `/api/stats`

## Table of Contents

- [Storage Statistics](#storage-statistics)
- [Library Statistics](#library-statistics)
- [Content Statistics](#content-statistics)
- [Usage Statistics](#usage-statistics)
- [Combined Actions](#combined-actions)
- [Snapshot Object References](#snapshot-object-references)

---

## Common Query Parameters

For all `/history` endpoints:

| Parameter | Type    | Default | Description                            |
| --------- | ------- | ------- | -------------------------------------- |
| `days`    | integer | 30      | Number of days to look back (max 365). |
| `limit`   | integer | 100     | Maximum number of snapshots to return. |

---

## Storage Statistics

### GET `/storage`

Returns real-time storage metrics by scanning directories and querying the database.

**Response (200 OK):**

```json
{
  "success": true,
  "data": {
    "total_video_size_bytes": 2497262330815,
    "total_video_count": 2063,
    "thumbnails_size_bytes": 46209552,
    "storyboards_size_bytes": 237948705,
    "profile_pictures_size_bytes": 111429684,
    "converted_size_bytes": 10486019086,
    "database_size_bytes": 2854328,
    "directory_breakdown": [
      {
        "directory_id": 1,
        "path": "/mnt/hd4tb/rafael",
        "size_bytes": 2497262330815,
        "video_count": 2063
      }
    ],
    "total_managed_size_bytes": 10884461355
  }
}
```

### GET `/storage/history`

Returns historical storage snapshots.

**Query Parameters:** `days`, `limit`

**Response (200 OK):**
Array of [Storage Snapshot Object](#storage-snapshot-object)

### POST `/storage/snapshot`

Manually triggers a storage statistics snapshot.

**Response (201 Created):**

```json
{
  "success": true,
  "data": { ... },
  "message": "Storage snapshot created"
}
```

---

## Library Statistics

### GET `/library`

Returns technical breakdown of the video library.

**Response (200 OK):**

```json
{
  "success": true,
  "data": {
    "total_video_count": 2063,
    "available_video_count": 2053,
    "unavailable_video_count": 10,
    "total_size_bytes": 2497262330815,
    "average_size_bytes": 1210499000,
    "total_duration_seconds": 1234567,
    "average_duration_seconds": 600,
    "resolution_breakdown": [
      { "resolution": "1080p", "count": 1276, "percentage": 62 },
      { "resolution": "720p", "count": 400, "percentage": 19 }
    ],
    "codec_breakdown": [
      { "codec": "h264", "count": 1500, "percentage": 73 },
      { "codec": "h265", "count": 500, "percentage": 24 }
    ]
  }
}
```

### GET `/library/history`

Returns historical library snapshots.

**Query Parameters:** `days`, `limit`

**Response (200 OK):**
Array of [Library Snapshot Object](#library-snapshot-object)

### POST `/library/snapshot`

Manually triggers a library statistics snapshot.

**Response (201 Created):**

```json
{
  "success": true,
  "data": { ... },
  "message": "Library snapshot created"
}
```

---

## Content Statistics

### GET `/content`

Returns statistics on content organization and metadata coverage.

**Response (200 OK):**

```json
{
  "success": true,
  "data": {
    "videos_without_tags": 2059,
    "videos_without_creators": 1916,
    "videos_without_ratings": 2000,
    "videos_without_thumbnails": 5,
    "videos_without_storyboards": 10,
    "total_tags": 50,
    "total_creators": 120,
    "total_studios": 15,
    "total_playlists": 8,
    "top_tags": [{ "id": 5, "name": "Action", "video_count": 45 }],
    "top_creators": [{ "id": 1, "name": "Creator Name", "video_count": 30 }]
  }
}
```

### GET `/content/history`

Returns historical content organization snapshots.

**Query Parameters:** `days`, `limit`

**Response (200 OK):**
Array of [Content Snapshot Object](#content-snapshot-object)

### POST `/content/snapshot`

Manually triggers a content statistics snapshot.

**Response (201 Created):**

```json
{
  "success": true,
  "data": { ... },
  "message": "Content snapshot created"
}
```

---

## Usage Statistics

### GET `/usage`

Returns watch statistics and user activity.

**Response (200 OK):**

```json
{
  "success": true,
  "data": {
    "total_watch_time_seconds": 12960,
    "total_play_count": 48,
    "unique_videos_watched": 45,
    "videos_never_watched": 2018,
    "average_completion_rate": 7.69,
    "top_watched": [
      {
        "video_id": 1984,
        "title": "Video Title",
        "play_count": 3,
        "total_watch_seconds": 515
      }
    ],
    "activity_by_hour": {
      "00": 0, "01": 0, "02": 0, ..., "12": 14, "13": 17, ...
    }
  }
}
```

### GET `/usage/history`

Returns historical usage snapshots.

**Query Parameters:** `days`, `limit`

**Response (200 OK):**
Array of [Usage Snapshot Object](#usage-snapshot-object)

### POST `/usage/snapshot`

Manually triggers a usage statistics snapshot.

**Response (201 Created):**

```json
{
  "success": true,
  "data": { ... },
  "message": "Usage snapshot created"
}
```

---

## Combined Actions

### POST `/snapshot`

Triggers a snapshot for all four categories (Storage, Library, Content, Usage) in a single request.

**Response (201 Created):**

```json
{
  "success": true,
  "data": {
    "storage": { ... },
    "library": { ... },
    "content": { ... },
    "usage": { ... }
  },
  "message": "All snapshots created"
}
```

---

## Snapshot Object References

### Storage Snapshot Object

```json
{
  "id": 1,
  "total_video_size_bytes": 2497262330815,
  "total_video_count": 2063,
  "thumbnails_size_bytes": 46209552,
  "storyboards_size_bytes": 237948705,
  "profile_pictures_size_bytes": 111429684,
  "converted_size_bytes": 10486019086,
  "database_size_bytes": 2854328,
  "directory_breakdown": [
    {
      "directory_id": 1,
      "path": "/path/to/directory",
      "size_bytes": 2497262330815,
      "video_count": 2063
    }
  ],
  "created_at": "2024-01-13T10:00:00Z"
}
```

### Library Snapshot Object

```json
{
  "id": 1,
  "total_video_count": 2063,
  "available_video_count": 2053,
  "unavailable_video_count": 10,
  "total_size_bytes": 2497262330815,
  "average_size_bytes": 1210499000,
  "total_duration_seconds": 1234567,
  "average_duration_seconds": 600,
  "resolution_breakdown": [
    { "resolution": "4K", "count": 88, "percentage": 4 },
    { "resolution": "1080p", "count": 1276, "percentage": 62 }
  ],
  "codec_breakdown": [
    { "codec": "h264", "count": 1500, "percentage": 73 },
    { "codec": "h265", "count": 500, "percentage": 24 }
  ],
  "created_at": "2024-01-13T10:00:00Z"
}
```

### Content Snapshot Object

```json
{
  "id": 1,
  "videos_without_tags": 2059,
  "videos_without_creators": 1916,
  "videos_without_ratings": 2000,
  "videos_without_thumbnails": 5,
  "videos_without_storyboards": 10,
  "total_tags": 50,
  "total_creators": 120,
  "total_studios": 15,
  "total_playlists": 8,
  "top_tags": [{ "id": 5, "name": "Action", "video_count": 45 }],
  "top_creators": [{ "id": 1, "name": "Creator Name", "video_count": 30 }],
  "created_at": "2024-01-13T10:00:00Z"
}
```

### Usage Snapshot Object

```json
{
  "id": 1,
  "total_watch_time_seconds": 12960,
  "total_play_count": 48,
  "unique_videos_watched": 45,
  "videos_never_watched": 2018,
  "average_completion_rate": 7.69,
  "top_watched": [
    {
      "video_id": 1984,
      "title": "Video Title",
      "play_count": 3,
      "total_watch_seconds": 515
    }
  ],
  "activity_by_hour": {
    "00": 0,
    "01": 0,
    "02": 0,
    "03": 0,
    "04": 0,
    "05": 0,
    "06": 1,
    "07": 2,
    "08": 5,
    "09": 8,
    "10": 12,
    "11": 15,
    "12": 14,
    "13": 17,
    "14": 5,
    "15": 2,
    "16": 3,
    "17": 7,
    "18": 10,
    "19": 12,
    "20": 9,
    "21": 6,
    "22": 4,
    "23": 2
  },
  "created_at": "2024-01-13T10:00:00Z"
}
```
