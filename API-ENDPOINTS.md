# API Endpoints Reference

Complete endpoint documentation for the Video Streaming Backend API. All endpoints are prefixed with `/api`.

## Table of Contents

1. [Auth Module](#1-auth-module)
2. [Videos Module](#2-videos-module)
3. [Directories Module](#3-directories-module)
4. [Creators Module](#4-creators-module)
5. [Tags Module](#5-tags-module)
6. [Playlists Module](#6-playlists-module)
7. [Favorites Module](#7-favorites-module)
8. [Bookmarks Module](#8-bookmarks-module)
9. [Ratings Module](#9-ratings-module)
10. [Thumbnails Module](#10-thumbnails-module)
11. [Backup Module](#11-backup-module)

**Legend**:
- ✅ = Authentication Required
- ❌ = No Authentication Required

---

## 1. Auth Module

Base path: `/api/auth`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/register` | ❌ | Register first user (only works once) |
| POST | `/login` | ❌ | Authenticate user and create session |
| POST | `/logout` | ✅ | Invalidate session |
| GET | `/me` | ✅ | Get current authenticated user |

### POST /api/auth/register

Register a new user. Only works if no user exists (single-user system).

**Request Body**:
```json
{
  "username": "string",  // 3-50 characters
  "password": "string"   // 8-100 characters
}
```

**Success Response (201)**:
```json
{
  "success": true,
  "data": {
    "id": 1,
    "username": "admin",
    "created_at": "2025-01-06T10:30:00.000Z",
    "updated_at": "2025-01-06T10:30:00.000Z"
  },
  "message": "User created successfully"
}
```

**Error Responses**:
- `400`: Validation error (invalid username/password format)
- `409`: User already exists

### POST /api/auth/login

Authenticate user and receive session cookie.

**Request Body**:
```json
{
  "username": "string",
  "password": "string"
}
```

**Success Response (200)**:
```json
{
  "success": true,
  "data": {
    "id": 1,
    "username": "admin",
    "created_at": "2025-01-06T10:30:00.000Z",
    "updated_at": "2025-01-06T10:30:00.000Z"
  },
  "message": "Logged in successfully"
}
```

**Response Headers**:
```
Set-Cookie: session_id=<UUID>; HttpOnly; SameSite=Lax; Max-Age=604800; Path=/
```

**Error Responses**:
- `400`: Validation error
- `401`: Invalid credentials

### POST /api/auth/logout

Logout and invalidate session.

**Request**: No body required

**Success Response (200)**:
```json
{
  "success": true,
  "message": "Logged out successfully"
}
```

**Error Responses**:
- `401`: Not authenticated

### GET /api/auth/me

Get current authenticated user information.

**Request**: No body required

**Success Response (200)**:
```json
{
  "success": true,
  "data": {
    "id": 1,
    "username": "admin",
    "created_at": "2025-01-06T10:30:00.000Z",
    "updated_at": "2025-01-06T10:30:00.000Z"
  }
}
```

**Error Responses**:
- `401`: Not authenticated

---

## 2. Videos Module

Base path: `/api/videos`

All endpoints require authentication.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | List videos with pagination and filtering |
| GET | `/:id` | Get video details by ID |
| PATCH | `/:id` | Update video metadata |
| DELETE | `/:id` | Delete video from database |
| POST | `/:id/verify` | Verify video file exists on disk |
| GET | `/:id/stream` | Stream video with HTTP range requests |
| GET | `/:id/creators` | Get all creators for a video |
| POST | `/:id/creators` | Add creator to video |
| DELETE | `/:id/creators/:creator_id` | Remove creator from video |
| GET | `/:id/tags` | Get all tags for a video |
| POST | `/:id/tags` | Add tag to video |
| DELETE | `/:id/tags/:tag_id` | Remove tag from video |
| GET | `/:id/metadata` | Get custom metadata for video |
| POST | `/:id/metadata` | Set custom metadata key-value |
| DELETE | `/:id/metadata/:key` | Delete metadata key |
| GET | `/:id/ratings` | Get all ratings and average |
| POST | `/:id/ratings` | Add or update rating |
| GET | `/:id/bookmarks` | Get all bookmarks for video |
| POST | `/:id/bookmarks` | Create bookmark at timestamp |

### GET /api/videos

List videos with pagination, filtering, and sorting.

**Query Parameters**:
```
page: number (default: 1)
limit: number (default: 20, max: 100)
directory_id: number (optional)
search: string (optional)
sort: "created_at" | "file_name" | "duration_seconds" | "file_size_bytes" | "indexed_at" (default: "created_at")
order: "asc" | "desc" (default: "desc")
```

**Success Response (200)**:
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "file_path": "/videos/tutorial.mp4",
      "file_name": "tutorial.mp4",
      "directory_id": 1,
      "file_size_bytes": 104857600,
      "file_hash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "duration_seconds": 3600,
      "width": 1920,
      "height": 1080,
      "codec": "h264",
      "bitrate": 5000000,
      "fps": 30,
      "audio_codec": "aac",
      "title": "Tutorial Video",
      "description": "A comprehensive tutorial",
      "themes": "education, programming",
      "is_available": 1,
      "last_verified_at": "2025-01-06T10:30:00.000Z",
      "indexed_at": "2025-01-05T08:00:00.000Z",
      "created_at": "2025-01-05T08:00:00.000Z",
      "updated_at": "2025-01-06T10:30:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 150,
    "totalPages": 8
  }
}
```

### GET /api/videos/:id

Get detailed information for a specific video.

**Path Parameters**:
- `id`: Video ID (number)

**Success Response (200)**:
```json
{
  "success": true,
  "data": {
    "id": 1,
    "file_path": "/videos/tutorial.mp4",
    "file_name": "tutorial.mp4",
    "directory_id": 1,
    "file_size_bytes": 104857600,
    "file_hash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "duration_seconds": 3600,
    "width": 1920,
    "height": 1080,
    "codec": "h264",
    "bitrate": 5000000,
    "fps": 30,
    "audio_codec": "aac",
    "title": "Tutorial Video",
    "description": "A comprehensive tutorial",
    "themes": "education, programming",
    "is_available": 1,
    "last_verified_at": "2025-01-06T10:30:00.000Z",
    "indexed_at": "2025-01-05T08:00:00.000Z",
    "created_at": "2025-01-05T08:00:00.000Z",
    "updated_at": "2025-01-06T10:30:00.000Z"
  }
}
```

**Error Responses**:
- `404`: Video not found

### PATCH /api/videos/:id

Update video metadata (title, description, themes).

**Path Parameters**:
- `id`: Video ID (number)

**Request Body** (all fields optional):
```json
{
  "title": "string | null",
  "description": "string | null",
  "themes": "string | null"
}
```

**Success Response (200)**:
```json
{
  "success": true,
  "data": {
    "id": 1,
    "title": "Updated Title",
    "description": "Updated description",
    "themes": "updated, themes"
  },
  "message": "Video updated successfully"
}
```

**Error Responses**:
- `404`: Video not found
- `400`: Validation error

### DELETE /api/videos/:id

Delete a video from the database.

**Path Parameters**:
- `id`: Video ID (number)

**Success Response (200)**:
```json
{
  "success": true,
  "message": "Video deleted successfully"
}
```

**Error Responses**:
- `404`: Video not found

### POST /api/videos/:id/verify

Verify that the video file exists on disk. Updates `is_available` flag.

**Path Parameters**:
- `id`: Video ID (number)

**Success Response (200)**:
```json
{
  "success": true,
  "data": {
    "is_available": 1,
    "last_verified_at": "2025-01-06T10:30:00.000Z"
  },
  "message": "Video file is available"
}
```

**Error Responses**:
- `404`: Video not found

### GET /api/videos/:id/stream

Stream video file with HTTP range request support.

**Path Parameters**:
- `id`: Video ID (number)

**Request Headers** (optional):
```
Range: bytes=0-1023
```

**Success Response (206 Partial Content)** or **(200 OK)**:
- Binary video file data
- `Content-Type`: video/mp4 (or appropriate MIME type)
- `Content-Range`: bytes 0-1023/104857600
- `Accept-Ranges`: bytes

**Notes**:
- Supports partial content delivery for efficient streaming
- Video players automatically send Range requests
- Returns 206 for range requests, 200 for full file

**Error Responses**:
- `404`: Video not found or file unavailable

### GET /api/videos/:id/creators

Get all creators associated with a video.

**Path Parameters**:
- `id`: Video ID (number)

**Success Response (200)**:
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "name": "John Doe",
      "description": "Content creator"
    }
  ]
}
```

### POST /api/videos/:id/creators

Add a creator to a video.

**Path Parameters**:
- `id`: Video ID (number)

**Request Body**:
```json
{
  "creator_id": 1
}
```

**Success Response (201)**:
```json
{
  "success": true,
  "message": "Creator added to video"
}
```

**Error Responses**:
- `404`: Video or creator not found
- `409`: Creator already associated with video

### DELETE /api/videos/:id/creators/:creator_id

Remove a creator from a video.

**Path Parameters**:
- `id`: Video ID (number)
- `creator_id`: Creator ID (number)

**Success Response (200)**:
```json
{
  "success": true,
  "message": "Creator removed from video"
}
```

### GET /api/videos/:id/tags

Get all tags associated with a video.

**Path Parameters**:
- `id`: Video ID (number)

**Success Response (200)**:
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "name": "Tutorial",
      "parent_id": null,
      "description": "Educational content"
    }
  ]
}
```

### POST /api/videos/:id/tags

Add a tag to a video.

**Path Parameters**:
- `id`: Video ID (number)

**Request Body**:
```json
{
  "tag_id": 1
}
```

**Success Response (201)**:
```json
{
  "success": true,
  "message": "Tag added to video"
}
```

**Error Responses**:
- `404`: Video or tag not found
- `409`: Tag already associated with video

### DELETE /api/videos/:id/tags/:tag_id

Remove a tag from a video.

**Path Parameters**:
- `id`: Video ID (number)
- `tag_id`: Tag ID (number)

**Success Response (200)**:
```json
{
  "success": true,
  "message": "Tag removed from video"
}
```

### GET /api/videos/:id/metadata

Get all custom metadata (key-value pairs) for a video.

**Path Parameters**:
- `id`: Video ID (number)

**Success Response (200)**:
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "video_id": 1,
      "key": "location",
      "value": "New York",
      "created_at": "2025-01-06T10:30:00.000Z",
      "updated_at": "2025-01-06T10:30:00.000Z"
    }
  ]
}
```

### POST /api/videos/:id/metadata

Set a custom metadata key-value pair for a video.

**Path Parameters**:
- `id`: Video ID (number)

**Request Body**:
```json
{
  "key": "string",    // 1-255 characters
  "value": "string"   // max 10000 characters
}
```

**Success Response (201)**:
```json
{
  "success": true,
  "message": "Metadata saved"
}
```

**Notes**:
- If key already exists, it will be updated
- Useful for custom fields not in the schema

### DELETE /api/videos/:id/metadata/:key

Delete a custom metadata key.

**Path Parameters**:
- `id`: Video ID (number)
- `key`: Metadata key (string)

**Success Response (200)**:
```json
{
  "success": true,
  "message": "Metadata deleted"
}
```

### GET /api/videos/:id/ratings

Get all ratings for a video and the average rating.

**Path Parameters**:
- `id`: Video ID (number)

**Success Response (200)**:
```json
{
  "success": true,
  "data": {
    "video_id": 1,
    "average_rating": 4.5,
    "total_ratings": 10,
    "ratings": [
      {
        "id": 1,
        "video_id": 1,
        "user_id": 1,
        "rating": 5,
        "comment": "Great video!",
        "rated_at": "2025-01-06T10:30:00.000Z"
      }
    ]
  }
}
```

### POST /api/videos/:id/ratings

Add or update a rating for a video. If user already rated, updates existing rating.

**Path Parameters**:
- `id`: Video ID (number)

**Request Body**:
```json
{
  "rating": 5,              // 1-5
  "comment": "string | null"
}
```

**Success Response (201)**:
```json
{
  "success": true,
  "data": {
    "id": 1,
    "video_id": 1,
    "user_id": 1,
    "rating": 5,
    "comment": "Great video!",
    "rated_at": "2025-01-06T10:30:00.000Z"
  },
  "message": "Rating added successfully"
}
```

**Error Responses**:
- `404`: Video not found
- `400`: Invalid rating (must be 1-5)

### GET /api/videos/:id/bookmarks

Get all bookmarks for a video.

**Path Parameters**:
- `id`: Video ID (number)

**Success Response (200)**:
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "video_id": 1,
      "user_id": 1,
      "timestamp_seconds": 120,
      "name": "Important moment",
      "description": "Key concept explained here",
      "created_at": "2025-01-06T10:30:00.000Z",
      "updated_at": "2025-01-06T10:30:00.000Z"
    }
  ]
}
```

### POST /api/videos/:id/bookmarks

Create a bookmark at a specific timestamp.

**Path Parameters**:
- `id`: Video ID (number)

**Request Body**:
```json
{
  "timestamp_seconds": 120,
  "name": "string",
  "description": "string | null"
}
```

**Success Response (201)**:
```json
{
  "success": true,
  "data": {
    "id": 1,
    "video_id": 1,
    "user_id": 1,
    "timestamp_seconds": 120,
    "name": "Important moment",
    "description": "Key concept explained here",
    "created_at": "2025-01-06T10:30:00.000Z",
    "updated_at": "2025-01-06T10:30:00.000Z"
  },
  "message": "Bookmark created successfully"
}
```

---

## 3. Directories Module

Base path: `/api/directories`

All endpoints require authentication.

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/` | Register directory for scanning |
| GET | `/` | List all registered directories |
| GET | `/:id` | Get directory details |
| PATCH | `/:id` | Update directory settings |
| DELETE | `/:id` | Remove directory from monitoring |
| POST | `/:id/scan` | Manually trigger directory scan |
| GET | `/:id/stats` | Get directory statistics |

### POST /api/directories

Register a new directory for video scanning.

**Request Body**:
```json
{
  "path": "string"  // Absolute directory path
}
```

**Success Response (201)**:
```json
{
  "success": true,
  "data": {
    "id": 1,
    "path": "/home/user/videos",
    "is_active": 1,
    "auto_scan": 0,
    "scan_interval_minutes": 60,
    "last_scan_at": "2025-01-06T10:30:00.000Z",
    "added_at": "2025-01-06T10:30:00.000Z",
    "updated_at": "2025-01-06T10:30:00.000Z"
  },
  "message": "Directory registered successfully. Scanning started."
}
```

**Notes**:
- Directory must exist and be accessible
- Scanning starts immediately upon registration
- Recursively finds all video files

**Error Responses**:
- `400`: Invalid path or directory doesn't exist
- `409`: Directory already registered

### GET /api/directories

List all registered directories.

**Success Response (200)**:
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "path": "/home/user/videos",
      "is_active": 1,
      "auto_scan": 0,
      "scan_interval_minutes": 60,
      "last_scan_at": "2025-01-06T10:30:00.000Z",
      "added_at": "2025-01-06T10:30:00.000Z",
      "updated_at": "2025-01-06T10:30:00.000Z"
    }
  ]
}
```

### GET /api/directories/:id

Get details for a specific directory.

**Path Parameters**:
- `id`: Directory ID (number)

**Success Response (200)**:
```json
{
  "success": true,
  "data": {
    "id": 1,
    "path": "/home/user/videos",
    "is_active": 1,
    "auto_scan": 0,
    "scan_interval_minutes": 60,
    "last_scan_at": "2025-01-06T10:30:00.000Z",
    "added_at": "2025-01-06T10:30:00.000Z",
    "updated_at": "2025-01-06T10:30:00.000Z"
  }
}
```

### PATCH /api/directories/:id

Update directory settings.

**Path Parameters**:
- `id`: Directory ID (number)

**Request Body** (all fields optional):
```json
{
  "is_active": 1,              // 0 or 1
  "auto_scan": 1,              // 0 or 1
  "scan_interval_minutes": 120
}
```

**Success Response (200)**:
```json
{
  "success": true,
  "data": {
    "id": 1,
    "is_active": 1,
    "auto_scan": 1,
    "scan_interval_minutes": 120
  },
  "message": "Directory updated successfully"
}
```

**Notes**:
- `auto_scan` feature is not yet implemented

### DELETE /api/directories/:id

Remove a directory from monitoring.

**Path Parameters**:
- `id`: Directory ID (number)

**Success Response (200)**:
```json
{
  "success": true,
  "message": "Directory deleted successfully"
}
```

**Notes**:
- Does not delete videos from database
- Only removes directory from monitoring

### POST /api/directories/:id/scan

Manually trigger a directory scan.

**Path Parameters**:
- `id`: Directory ID (number)

**Success Response (200)**:
```json
{
  "success": true,
  "message": "Directory scan started"
}
```

**Notes**:
- Scan runs asynchronously
- Updates `last_scan_at` timestamp
- Marks missing videos as `is_available = 0`

### GET /api/directories/:id/stats

Get statistics for a directory.

**Path Parameters**:
- `id`: Directory ID (number)

**Success Response (200)**:
```json
{
  "success": true,
  "data": {
    "directory_id": 1,
    "total_videos": 150,
    "total_size_bytes": 15728640000,
    "available_videos": 148,
    "unavailable_videos": 2
  }
}
```

---

## 4. Creators Module

Base path: `/api/creators`

All endpoints require authentication.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | List all creators |
| GET | `/:id` | Get creator details |
| POST | `/` | Create a new creator |
| PATCH | `/:id` | Update creator details |
| DELETE | `/:id` | Delete a creator |
| GET | `/:id/videos` | Get all videos by creator |

### POST /api/creators

Create a new creator.

**Request Body**:
```json
{
  "name": "string",
  "description": "string | null"
}
```

**Success Response (201)**:
```json
{
  "success": true,
  "data": {
    "id": 1,
    "name": "John Doe",
    "description": "Content creator",
    "created_at": "2025-01-06T10:30:00.000Z",
    "updated_at": "2025-01-06T10:30:00.000Z"
  },
  "message": "Creator created successfully"
}
```

### GET /api/creators

List all creators.

**Success Response (200)**:
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "name": "John Doe",
      "description": "Content creator",
      "created_at": "2025-01-06T10:30:00.000Z",
      "updated_at": "2025-01-06T10:30:00.000Z"
    }
  ]
}
```

### GET /api/creators/:id

Get details for a specific creator.

**Path Parameters**:
- `id`: Creator ID (number)

**Success Response (200)**:
```json
{
  "success": true,
  "data": {
    "id": 1,
    "name": "John Doe",
    "description": "Content creator",
    "created_at": "2025-01-06T10:30:00.000Z",
    "updated_at": "2025-01-06T10:30:00.000Z"
  }
}
```

### PATCH /api/creators/:id

Update creator details.

**Path Parameters**:
- `id`: Creator ID (number)

**Request Body** (all fields optional):
```json
{
  "name": "string",
  "description": "string | null"
}
```

**Success Response (200)**:
```json
{
  "success": true,
  "data": {
    "id": 1,
    "name": "Jane Doe",
    "description": "Updated description"
  },
  "message": "Creator updated successfully"
}
```

### DELETE /api/creators/:id

Delete a creator.

**Path Parameters**:
- `id`: Creator ID (number)

**Success Response (200)**:
```json
{
  "success": true,
  "message": "Creator deleted successfully"
}
```

**Notes**:
- Removes all video-creator associations

### GET /api/creators/:id/videos

Get all videos by a specific creator.

**Path Parameters**:
- `id`: Creator ID (number)

**Success Response (200)**:
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "file_name": "tutorial.mp4",
      "title": "Tutorial Video",
      "duration_seconds": 3600,
      "created_at": "2025-01-06T10:30:00.000Z"
    }
  ]
}
```

---

## 5. Tags Module

Base path: `/api/tags`

All endpoints require authentication.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | List all tags (optionally as tree) |
| GET | `/:id` | Get tag with hierarchical path |
| POST | `/` | Create a new tag |
| PATCH | `/:id` | Update tag details |
| DELETE | `/:id` | Delete tag (cascades to children) |
| GET | `/:id/children` | Get direct child tags |
| GET | `/:id/videos` | Get all videos with this tag |

### POST /api/tags

Create a new tag.

**Request Body**:
```json
{
  "name": "string",
  "description": "string | null",
  "parent_id": "number | null"  // Optional, for hierarchical tags
}
```

**Success Response (201)**:
```json
{
  "success": true,
  "data": {
    "id": 1,
    "name": "Tutorial",
    "parent_id": null,
    "description": "Educational content",
    "created_at": "2025-01-06T10:30:00.000Z",
    "updated_at": "2025-01-06T10:30:00.000Z"
  },
  "message": "Tag created successfully"
}
```

### GET /api/tags

List all tags. Supports tree structure with `?tree=true`.

**Query Parameters**:
```
tree: boolean (default: false)
```

**Success Response (200)** - Flat List (`tree=false`):
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "name": "Tutorial",
      "parent_id": null,
      "description": "Educational content",
      "created_at": "2025-01-06T10:30:00.000Z",
      "updated_at": "2025-01-06T10:30:00.000Z"
    },
    {
      "id": 2,
      "name": "Programming",
      "parent_id": 1,
      "description": "Programming tutorials",
      "created_at": "2025-01-06T10:30:00.000Z",
      "updated_at": "2025-01-06T10:30:00.000Z"
    }
  ]
}
```

**Success Response (200)** - Tree Structure (`tree=true`):
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "name": "Tutorial",
      "parent_id": null,
      "description": "Educational content",
      "created_at": "2025-01-06T10:30:00.000Z",
      "updated_at": "2025-01-06T10:30:00.000Z",
      "children": [
        {
          "id": 2,
          "name": "Programming",
          "parent_id": 1,
          "description": "Programming tutorials",
          "created_at": "2025-01-06T10:30:00.000Z",
          "updated_at": "2025-01-06T10:30:00.000Z",
          "children": []
        }
      ]
    }
  ]
}
```

### GET /api/tags/:id

Get tag details with hierarchical path.

**Path Parameters**:
- `id`: Tag ID (number)

**Success Response (200)**:
```json
{
  "success": true,
  "data": {
    "id": 2,
    "name": "Programming",
    "parent_id": 1,
    "description": "Programming tutorials",
    "path": "Tutorial > Programming",
    "created_at": "2025-01-06T10:30:00.000Z",
    "updated_at": "2025-01-06T10:30:00.000Z"
  }
}
```

**Notes**:
- `path` shows full hierarchy (e.g., "Parent > Child > Grandchild")

### PATCH /api/tags/:id

Update tag details.

**Path Parameters**:
- `id`: Tag ID (number)

**Request Body** (all fields optional):
```json
{
  "name": "string",
  "description": "string | null",
  "parent_id": "number | null"
}
```

**Success Response (200)**:
```json
{
  "success": true,
  "data": {
    "id": 2,
    "name": "Web Programming",
    "parent_id": 1,
    "description": "Web development tutorials"
  },
  "message": "Tag updated successfully"
}
```

### DELETE /api/tags/:id

Delete a tag. Cascades to all child tags.

**Path Parameters**:
- `id`: Tag ID (number)

**Success Response (200)**:
```json
{
  "success": true,
  "message": "Tag deleted successfully"
}
```

**Notes**:
- Deleting a parent tag deletes all children
- Removes all video-tag associations

### GET /api/tags/:id/children

Get direct child tags.

**Path Parameters**:
- `id`: Tag ID (number)

**Success Response (200)**:
```json
{
  "success": true,
  "data": [
    {
      "id": 2,
      "name": "Programming",
      "parent_id": 1,
      "description": "Programming tutorials",
      "created_at": "2025-01-06T10:30:00.000Z",
      "updated_at": "2025-01-06T10:30:00.000Z"
    }
  ]
}
```

### GET /api/tags/:id/videos

Get all videos with this tag.

**Path Parameters**:
- `id`: Tag ID (number)

**Success Response (200)**:
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "file_name": "tutorial.mp4",
      "title": "Tutorial Video",
      "duration_seconds": 3600,
      "created_at": "2025-01-06T10:30:00.000Z"
    }
  ]
}
```

---

## 6. Playlists Module

Base path: `/api/playlists`

All endpoints require authentication.

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/` | Create a new playlist |
| GET | `/` | List user's playlists |
| GET | `/:id` | Get playlist details |
| PATCH | `/:id` | Update playlist |
| DELETE | `/:id` | Delete playlist |
| GET | `/:id/videos` | Get videos in playlist (ordered) |
| POST | `/:id/videos` | Add video to playlist |
| DELETE | `/:id/videos/:video_id` | Remove video from playlist |
| PATCH | `/:id/videos/reorder` | Reorder videos in playlist |

### POST /api/playlists

Create a new playlist.

**Request Body**:
```json
{
  "name": "string",
  "description": "string | null"
}
```

**Success Response (201)**:
```json
{
  "success": true,
  "data": {
    "id": 1,
    "user_id": 1,
    "name": "My Favorites",
    "description": "Collection of favorite videos",
    "created_at": "2025-01-06T10:30:00.000Z",
    "updated_at": "2025-01-06T10:30:00.000Z"
  },
  "message": "Playlist created successfully"
}
```

### GET /api/playlists

List all playlists for the current user.

**Success Response (200)**:
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "user_id": 1,
      "name": "My Favorites",
      "description": "Collection of favorite videos",
      "created_at": "2025-01-06T10:30:00.000Z",
      "updated_at": "2025-01-06T10:30:00.000Z"
    }
  ]
}
```

### GET /api/playlists/:id

Get playlist details.

**Path Parameters**:
- `id`: Playlist ID (number)

**Success Response (200)**:
```json
{
  "success": true,
  "data": {
    "id": 1,
    "user_id": 1,
    "name": "My Favorites",
    "description": "Collection of favorite videos",
    "created_at": "2025-01-06T10:30:00.000Z",
    "updated_at": "2025-01-06T10:30:00.000Z"
  }
}
```

### PATCH /api/playlists/:id

Update playlist details.

**Path Parameters**:
- `id`: Playlist ID (number)

**Request Body** (all fields optional):
```json
{
  "name": "string",
  "description": "string | null"
}
```

**Success Response (200)**:
```json
{
  "success": true,
  "data": {
    "id": 1,
    "name": "Updated Name",
    "description": "Updated description"
  },
  "message": "Playlist updated successfully"
}
```

### DELETE /api/playlists/:id

Delete a playlist.

**Path Parameters**:
- `id`: Playlist ID (number)

**Success Response (200)**:
```json
{
  "success": true,
  "message": "Playlist deleted successfully"
}
```

### GET /api/playlists/:id/videos

Get videos in a playlist, ordered by position.

**Path Parameters**:
- `id`: Playlist ID (number)

**Success Response (200)**:
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "file_name": "video1.mp4",
      "title": "First Video",
      "duration_seconds": 3600,
      "position": 0,
      "added_at": "2025-01-06T10:30:00.000Z"
    },
    {
      "id": 2,
      "file_name": "video2.mp4",
      "title": "Second Video",
      "duration_seconds": 2400,
      "position": 1,
      "added_at": "2025-01-06T10:30:00.000Z"
    }
  ]
}
```

### POST /api/playlists/:id/videos

Add a video to a playlist.

**Path Parameters**:
- `id`: Playlist ID (number)

**Request Body**:
```json
{
  "video_id": 1,
  "position": 0  // Optional, defaults to end of playlist
}
```

**Success Response (201)**:
```json
{
  "success": true,
  "message": "Video added to playlist"
}
```

**Notes**:
- If position is not specified, video is added to the end
- If position is specified, subsequent videos are shifted

### DELETE /api/playlists/:id/videos/:video_id

Remove a video from a playlist.

**Path Parameters**:
- `id`: Playlist ID (number)
- `video_id`: Video ID (number)

**Success Response (200)**:
```json
{
  "success": true,
  "message": "Video removed from playlist"
}
```

### PATCH /api/playlists/:id/videos/reorder

Reorder videos in a playlist.

**Path Parameters**:
- `id`: Playlist ID (number)

**Request Body**:
```json
{
  "videos": [
    { "video_id": 2, "position": 0 },
    { "video_id": 1, "position": 1 },
    { "video_id": 3, "position": 2 }
  ]
}
```

**Success Response (200)**:
```json
{
  "success": true,
  "message": "Playlist reordered successfully"
}
```

**Notes**:
- Updates positions for all videos in the playlist
- Positions should be sequential starting from 0

---

## 7. Favorites Module

Base path: `/api/favorites`

All endpoints require authentication.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | List favorite videos |
| POST | `/` | Add video to favorites |
| DELETE | `/:video_id` | Remove video from favorites |
| GET | `/:video_id/check` | Check if video is favorited |

### GET /api/favorites

List all favorite videos.

**Success Response (200)**:
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "file_name": "tutorial.mp4",
      "title": "Tutorial Video",
      "duration_seconds": 3600,
      "added_at": "2025-01-06T10:30:00.000Z"
    }
  ]
}
```

### POST /api/favorites

Add a video to favorites.

**Request Body**:
```json
{
  "video_id": 1
}
```

**Success Response (201)**:
```json
{
  "success": true,
  "message": "Video added to favorites"
}
```

**Error Responses**:
- `404`: Video not found
- `409`: Video already favorited

### DELETE /api/favorites/:video_id

Remove a video from favorites.

**Path Parameters**:
- `video_id`: Video ID (number)

**Success Response (200)**:
```json
{
  "success": true,
  "message": "Video removed from favorites"
}
```

### GET /api/favorites/:video_id/check

Check if a video is in favorites.

**Path Parameters**:
- `video_id`: Video ID (number)

**Success Response (200)**:
```json
{
  "success": true,
  "data": {
    "is_favorite": true
  }
}
```

---

## 8. Bookmarks Module

Base path: `/api/bookmarks`

All endpoints require authentication.

| Method | Endpoint | Description |
|--------|----------|-------------|
| PATCH | `/:id` | Update bookmark details |
| DELETE | `/:id` | Delete a bookmark |

**Note**: Bookmark creation is done via `POST /api/videos/:id/bookmarks`.

### PATCH /api/bookmarks/:id

Update bookmark details.

**Path Parameters**:
- `id`: Bookmark ID (number)

**Request Body** (all fields optional):
```json
{
  "timestamp_seconds": 120,
  "name": "string",
  "description": "string | null"
}
```

**Success Response (200)**:
```json
{
  "success": true,
  "data": {
    "id": 1,
    "video_id": 1,
    "user_id": 1,
    "timestamp_seconds": 120,
    "name": "Updated name",
    "description": "Updated description",
    "created_at": "2025-01-06T10:30:00.000Z",
    "updated_at": "2025-01-06T10:35:00.000Z"
  },
  "message": "Bookmark updated successfully"
}
```

### DELETE /api/bookmarks/:id

Delete a bookmark.

**Path Parameters**:
- `id`: Bookmark ID (number)

**Success Response (200)**:
```json
{
  "success": true,
  "message": "Bookmark deleted successfully"
}
```

---

## 9. Ratings Module

Base path: `/api/ratings`

All endpoints require authentication.

| Method | Endpoint | Description |
|--------|----------|-------------|
| PATCH | `/:id` | Update rating score or comment |
| DELETE | `/:id` | Delete a rating |

**Note**: Rating creation is done via `POST /api/videos/:id/ratings`.

### PATCH /api/ratings/:id

Update a rating's score or comment.

**Path Parameters**:
- `id`: Rating ID (number)

**Request Body** (all fields optional):
```json
{
  "rating": 4,              // 1-5
  "comment": "string | null"
}
```

**Success Response (200)**:
```json
{
  "success": true,
  "data": {
    "id": 1,
    "video_id": 1,
    "user_id": 1,
    "rating": 4,
    "comment": "Updated comment",
    "rated_at": "2025-01-06T10:30:00.000Z"
  },
  "message": "Rating updated successfully"
}
```

### DELETE /api/ratings/:id

Delete a rating.

**Path Parameters**:
- `id`: Rating ID (number)

**Success Response (200)**:
```json
{
  "success": true,
  "message": "Rating deleted successfully"
}
```

---

## 10. Thumbnails Module

Routes registered at API root to support custom paths.

All endpoints require authentication.

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/videos/:id/thumbnails` | Generate thumbnail at timestamp |
| GET | `/videos/:id/thumbnails` | Get all thumbnails for video |
| GET | `/thumbnails/:id/image` | Serve thumbnail image file |
| DELETE | `/thumbnails/:id` | Delete thumbnail |

### POST /api/videos/:id/thumbnails

Generate a thumbnail from a video frame.

**Path Parameters**:
- `id`: Video ID (number)

**Request Body**:
```json
{
  "timestamp_seconds": 120
}
```

**Success Response (201)**:
```json
{
  "success": true,
  "data": {
    "id": 1,
    "video_id": 1,
    "file_path": "/thumbnails/video1_120.jpg",
    "file_size_bytes": 51200,
    "timestamp_seconds": 120,
    "width": 320,
    "height": 180,
    "generated_at": "2025-01-06T10:30:00.000Z"
  },
  "message": "Thumbnail generated successfully"
}
```

**Notes**:
- Thumbnails are JPEG images extracted using FFmpeg
- Default size: 320x180 pixels

### GET /api/videos/:id/thumbnails

Get all thumbnails for a video.

**Path Parameters**:
- `id`: Video ID (number)

**Success Response (200)**:
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "video_id": 1,
      "file_path": "/thumbnails/video1_120.jpg",
      "file_size_bytes": 51200,
      "timestamp_seconds": 120,
      "width": 320,
      "height": 180,
      "generated_at": "2025-01-06T10:30:00.000Z"
    }
  ]
}
```

### GET /api/thumbnails/:id/image

Serve thumbnail image file.

**Path Parameters**:
- `id`: Thumbnail ID (number)

**Success Response (200)**:
- Binary JPEG image data
- `Content-Type: image/jpeg`

**Usage**:
```html
<img src="http://localhost:3000/api/thumbnails/1/image" alt="Thumbnail" />
```

### DELETE /api/thumbnails/:id

Delete a thumbnail.

**Path Parameters**:
- `id`: Thumbnail ID (number)

**Success Response (200)**:
```json
{
  "success": true,
  "message": "Thumbnail deleted successfully"
}
```

**Notes**:
- Deletes both database record and image file

---

## 11. Backup Module

Base path: `/api/backup`

All endpoints require authentication.

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/` | Create database backup |
| GET | `/` | List all backups |
| GET | `/export` | Export database as JSON |
| POST | `/:filename/restore` | Restore from backup |
| DELETE | `/:filename` | Delete backup file |

### POST /api/backup

Create a database backup.

**Request**: No body required

**Success Response (201)**:
```json
{
  "success": true,
  "data": {
    "filename": "backup-2025-01-06-103000.db",
    "path": "/backups/backup-2025-01-06-103000.db",
    "sizeBytes": 10485760,
    "createdAt": "2025-01-06T10:30:00.000Z"
  },
  "message": "Backup created successfully"
}
```

**Notes**:
- Creates SQLite database copy
- Filename format: `backup-YYYY-MM-DD-HHMMSS.db`

### GET /api/backup

List all available backups.

**Success Response (200)**:
```json
{
  "success": true,
  "data": [
    {
      "filename": "backup-2025-01-06-103000.db",
      "path": "/backups/backup-2025-01-06-103000.db",
      "sizeBytes": 10485760,
      "createdAt": "2025-01-06T10:30:00.000Z"
    }
  ]
}
```

### GET /api/backup/export

Export database as JSON file.

**Success Response (200)**:
- JSON file download
- `Content-Type: application/json`
- `Content-Disposition: attachment; filename="export-2025-01-06.json"`

**Notes**:
- Exports all tables as JSON
- Can be imported manually if needed

### POST /api/backup/:filename/restore

Restore database from a backup.

**Path Parameters**:
- `filename`: Backup filename (string)

**Request**: No body required

**Success Response (200)**:
```json
{
  "success": true,
  "message": "Database restored successfully"
}
```

**Notes**:
- Replaces current database with backup
- Server restart may be required

### DELETE /api/backup/:filename

Delete a backup file.

**Path Parameters**:
- `filename`: Backup filename (string)

**Success Response (200)**:
```json
{
  "success": true,
  "message": "Backup deleted successfully"
}
```

---

## Common Patterns Across All Endpoints

### Authentication

All endpoints (except Auth module) require authentication via session cookie:

```http
Cookie: session_id=550e8400-e29b-41d4-a716-446655440000
```

If not authenticated:
```json
{
  "success": false,
  "error": {
    "message": "Unauthorized",
    "statusCode": 401
  }
}
```

### Resource Not Found

When a resource doesn't exist:
```json
{
  "success": false,
  "error": {
    "message": "Video not found",
    "statusCode": 404
  }
}
```

### Validation Errors

When request body validation fails:
```json
{
  "success": false,
  "error": {
    "message": "Validation failed: rating must be between 1 and 5",
    "statusCode": 400
  }
}
```

### Duplicate Resource

When trying to create a duplicate:
```json
{
  "success": false,
  "error": {
    "message": "Creator already added to video",
    "statusCode": 409
  }
}
```

---

## Next Steps

- **Read API-OVERVIEW.md** for authentication and common patterns
- **Read FRONTEND-CHECKLIST.md** for implementation roadmap
- **Test endpoints** using Swagger UI at `/docs`
