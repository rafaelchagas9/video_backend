# API Overview

Quick start guide for the Video Streaming Backend API. This document covers authentication, common patterns, and data models.

## Table of Contents

- [Getting Started](#getting-started)
- [Authentication](#authentication)
- [Common Patterns](#common-patterns)
- [Data Models](#data-models)

---

## Getting Started

### Base Configuration

- **Base URL**: `http://localhost:3000/api`
- **API Prefix**: All endpoints are prefixed with `/api`
- **Documentation**: Interactive Swagger UI available at `/docs`
- **Health Check**: `GET /health` (no authentication required)

### Environment Variables

The backend requires the following environment configuration:

- `PORT`: Server port (default: 3000)
- `HOST`: Server host (default: localhost)
- `SESSION_SECRET`: Minimum 32 characters (required for session cookies)
- `SESSION_EXPIRY_HOURS`: Session duration in hours (default: 168 = 7 days)
- `DATABASE_PATH`: SQLite database file location

### Quick Start Example

```bash
# 1. Health check
curl http://localhost:3000/health

# 2. Register first user (only works once)
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username": "admin", "password": "securepass123"}'

# 3. Login and save session cookie
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username": "admin", "password": "securepass123"}' \
  -c cookies.txt

# 4. Make authenticated request
curl http://localhost:3000/api/videos \
  -b cookies.txt
```

---

## Authentication

### Session-Based Authentication

The API uses **session-based authentication** with httpOnly cookies. Sessions are stored server-side in SQLite.

#### Key Characteristics

- **Cookie Name**: `session_id`
- **Cookie Type**: httpOnly (not accessible via JavaScript)
- **Cookie Security**: Secure flag enabled in production
- **SameSite Policy**: `Lax`
- **Session Duration**: 7 days (168 hours) by default
- **Password Hashing**: bcrypt with 12 rounds
- **Single User System**: Only one user can be registered

### Authentication Flow

#### 1. Registration (One-Time Only)

```http
POST /api/auth/register
Content-Type: application/json

{
  "username": "admin",
  "password": "securepass123"
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

**Error Response (409)** - User already exists:
```json
{
  "success": false,
  "error": {
    "message": "User already exists",
    "statusCode": 409
  }
}
```

**Validation Rules**:
- `username`: 3-50 characters
- `password`: 8-100 characters

#### 2. Login

```http
POST /api/auth/login
Content-Type: application/json

{
  "username": "admin",
  "password": "securepass123"
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
Set-Cookie: session_id=550e8400-e29b-41d4-a716-446655440000; HttpOnly; SameSite=Lax; Max-Age=604800; Path=/
```

**Error Response (401)** - Invalid credentials:
```json
{
  "success": false,
  "error": {
    "message": "Invalid credentials",
    "statusCode": 401
  }
}
```

#### 3. Logout

```http
POST /api/auth/logout
Cookie: session_id=550e8400-e29b-41d4-a716-446655440000
```

**Success Response (200)**:
```json
{
  "success": true,
  "message": "Logged out successfully"
}
```

#### 4. Get Current User

```http
GET /api/auth/me
Cookie: session_id=550e8400-e29b-41d4-a716-446655440000
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
  }
}
```

### Frontend Authentication Implementation

#### JavaScript Fetch Example

```javascript
// Login
const login = async (username, password) => {
  const response = await fetch('http://localhost:3000/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include', // Important: Include cookies
    body: JSON.stringify({ username, password })
  });

  const data = await response.json();

  if (!data.success) {
    throw new Error(data.error.message);
  }

  return data.data; // User object
};

// Make authenticated requests
const getVideos = async () => {
  const response = await fetch('http://localhost:3000/api/videos', {
    credentials: 'include' // Include session cookie
  });

  if (response.status === 401) {
    // Redirect to login
    window.location.href = '/login';
    return;
  }

  return await response.json();
};

// Logout
const logout = async () => {
  await fetch('http://localhost:3000/api/auth/logout', {
    method: 'POST',
    credentials: 'include'
  });

  window.location.href = '/login';
};
```

#### Axios Example

```javascript
import axios from 'axios';

// Configure axios to include cookies
axios.defaults.withCredentials = true;
axios.defaults.baseURL = 'http://localhost:3000/api';

// Add response interceptor for 401 errors
axios.interceptors.response.use(
  response => response,
  error => {
    if (error.response?.status === 401) {
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

// Login
const login = async (username, password) => {
  const { data } = await axios.post('/auth/login', { username, password });
  return data.data; // User object
};

// Logout
const logout = async () => {
  await axios.post('/auth/logout');
  window.location.href = '/login';
};
```

---

## Common Patterns

### Response Format

All API responses follow a consistent structure:

#### Success Response

```json
{
  "success": true,
  "data": { /* Response data */ },
  "message": "Optional success message"
}
```

#### Error Response

```json
{
  "success": false,
  "error": {
    "message": "Error description",
    "statusCode": 400
  }
}
```

### HTTP Status Codes

| Code | Meaning | When It Occurs |
|------|---------|----------------|
| 200 | OK | Successful GET, PATCH, or DELETE request |
| 201 | Created | Successful POST request creating a resource |
| 400 | Bad Request | Validation error in request body/params |
| 401 | Unauthorized | Not authenticated or session expired |
| 404 | Not Found | Resource doesn't exist |
| 409 | Conflict | Duplicate resource (e.g., user already exists) |
| 500 | Internal Server Error | Unexpected server error |

### Pagination

List endpoints support pagination with consistent query parameters:

```http
GET /api/videos?page=1&limit=20
```

**Query Parameters**:
- `page`: Page number (default: 1)
- `limit`: Items per page (default: 20, max: 100)

**Response Structure**:
```json
{
  "success": true,
  "data": [ /* Array of items */ ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 150,
    "totalPages": 8
  }
}
```

### Filtering and Sorting

List endpoints often support filtering and sorting:

```http
GET /api/videos?search=tutorial&sort=created_at&order=desc
```

**Common Query Parameters**:
- `search`: Text search (varies by endpoint)
- `sort`: Field to sort by (e.g., `created_at`, `file_name`, `duration_seconds`)
- `order`: Sort direction (`asc` or `desc`, default: `desc`)
- `directory_id`: Filter by directory (for videos)

### Validation Errors

When validation fails (400 Bad Request):

```json
{
  "success": false,
  "error": {
    "message": "Validation failed: username must be at least 3 characters",
    "statusCode": 400
  }
}
```

---

## Data Models

### User

```typescript
{
  id: number;
  username: string;
  created_at: string; // ISO 8601 timestamp
  updated_at: string;
}
```

**Notes**:
- Single user system (only one user can exist)
- Password is never returned in responses

### Video

```typescript
{
  id: number;
  file_path: string;           // Absolute path on server
  file_name: string;            // Original filename
  directory_id: number;         // Foreign key to directory
  file_size_bytes: number;
  file_hash: string | null;     // SHA256 hash

  // Metadata (extracted via FFprobe)
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  codec: string | null;         // Video codec (e.g., "h264")
  bitrate: number | null;
  fps: number | null;           // Frames per second
  audio_codec: string | null;   // Audio codec (e.g., "aac")

  // User-defined metadata
  title: string | null;
  description: string | null;
  themes: string | null;

  // Availability
  is_available: number;         // 0 or 1 (boolean)
  last_verified_at: string | null;

  // Timestamps
  indexed_at: string;           // When file was indexed
  created_at: string;
  updated_at: string;
}
```

**Notes**:
- `is_available = 0` means file is missing from disk (soft delete)
- Metadata fields are nullable (extraction might fail)
- Supported formats: mkv, mp4, mov, wmv, avi, flv, webm, m4v, mpg, mpeg

### Directory

```typescript
{
  id: number;
  path: string;                 // Absolute directory path
  is_active: number;            // 0 or 1 (boolean)
  auto_scan: number;            // 0 or 1 (boolean)
  scan_interval_minutes: number;
  last_scan_at: string | null;
  added_at: string;
  updated_at: string;
}
```

**Notes**:
- Directories are scanned recursively for video files
- `auto_scan` enables scheduled scanning (not yet implemented)

### Creator

```typescript
{
  id: number;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}
```

**Relationship**:
- Many-to-many with videos via `video_creators` junction table

### Tag

```typescript
{
  id: number;
  name: string;
  parent_id: number | null;     // Self-reference for hierarchy
  description: string | null;
  created_at: string;
  updated_at: string;

  // Only when using ?tree=true
  children?: Tag[];             // Recursive nested tags
}
```

**Notes**:
- Tags support hierarchical relationships via `parent_id`
- Tree queries return nested structures with `children` arrays
- Deleting a tag cascades to all children

### Playlist

```typescript
{
  id: number;
  user_id: number;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}
```

**Playlist Video** (junction table):
```typescript
{
  playlist_id: number;
  video_id: number;
  position: number;             // Order in playlist
  added_at: string;
}
```

**Notes**:
- Videos in playlists have a `position` field for custom ordering
- Positions start at 0 and increment

### Rating

```typescript
{
  id: number;
  video_id: number;
  user_id: number;
  rating: number;               // 1-5
  comment: string | null;
  rated_at: string;
}
```

**Average Rating Response**:
```typescript
{
  video_id: number;
  average_rating: number | null;
  total_ratings: number;
  ratings: Rating[];
}
```

### Bookmark

```typescript
{
  id: number;
  video_id: number;
  user_id: number;
  timestamp_seconds: number;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}
```

**Notes**:
- Bookmarks mark specific timestamps in videos
- Useful for chapters, highlights, or notes

### Favorite

```typescript
{
  video_id: number;
  user_id: number;
  added_at: string;
}
```

**Notes**:
- Simple junction table for favorited videos

### Thumbnail

```typescript
{
  id: number;
  video_id: number;
  file_path: string;            // Path to JPEG file
  file_size_bytes: number;
  timestamp_seconds: number;    // Frame position
  width: number;
  height: number;
  generated_at: string;
}
```

**Notes**:
- Thumbnails are JPEG images extracted from video frames
- Generated on-demand via FFmpeg

### Custom Metadata

```typescript
{
  id: number;
  video_id: number;
  key: string;                  // Max 255 chars
  value: string;                // Max 10000 chars
  created_at: string;
  updated_at: string;
}
```

**Notes**:
- Arbitrary key-value pairs per video
- Useful for custom fields not in schema

### Backup

```typescript
{
  filename: string;             // e.g., "backup-2025-01-06-103000.db"
  path: string;                 // Absolute file path
  sizeBytes: number;
  createdAt: string;
}
```

**Notes**:
- Database backups are SQLite file copies
- Can be restored or exported as JSON

---

## Relationship Patterns

### Many-to-Many Relationships

The API uses junction tables for many-to-many relationships:

1. **Videos ↔ Creators** (`video_creators`)
   - `POST /api/videos/:id/creators` - Add creator to video
   - `DELETE /api/videos/:id/creators/:creator_id` - Remove association

2. **Videos ↔ Tags** (`video_tags`)
   - `POST /api/videos/:id/tags` - Tag a video
   - `DELETE /api/videos/:id/tags/:tag_id` - Remove tag

3. **Playlists ↔ Videos** (`playlist_videos`)
   - Includes `position` field for ordering
   - `POST /api/playlists/:id/videos` - Add video to playlist
   - `PATCH /api/playlists/:id/videos/reorder` - Reorder videos

### One-to-Many Relationships

1. **User → Playlists** (one user, many playlists)
2. **User → Ratings** (one user, many ratings)
3. **User → Bookmarks** (one user, many bookmarks)
4. **Directory → Videos** (one directory, many videos)
5. **Video → Bookmarks** (one video, many bookmarks)
6. **Video → Ratings** (one video, many ratings)
7. **Video → Thumbnails** (one video, many thumbnails)
8. **Tag → Tag** (self-reference for hierarchy)

---

## Best Practices

### 1. Always Handle 401 Errors

Session expiration or invalid sessions return 401. Redirect to login:

```javascript
if (response.status === 401) {
  window.location.href = '/login';
}
```

### 2. Include Credentials in Requests

Always use `credentials: 'include'` (fetch) or `withCredentials: true` (axios):

```javascript
fetch(url, { credentials: 'include' })
```

### 3. Handle Empty States

Check for empty arrays or null values in responses:

```javascript
if (data.data.length === 0) {
  // Show "no videos found" message
}
```

### 4. Use Pagination for Large Lists

Avoid loading all items at once. Use pagination:

```javascript
const loadVideos = (page = 1, limit = 20) => {
  return fetch(`/api/videos?page=${page}&limit=${limit}`, {
    credentials: 'include'
  });
};
```

### 5. Display Loading States

Show spinners or skeletons during API calls:

```javascript
setLoading(true);
const data = await getVideos();
setLoading(false);
```

### 6. Handle Soft-Deleted Videos

Videos with `is_available = 0` are missing from disk. Show appropriate UI:

```javascript
if (video.is_available === 0) {
  return <div className="unavailable">File not found</div>;
}
```

### 7. Use HTTP Range Requests for Video Streaming

For efficient video playback, use the `Range` header:

```html
<video>
  <source src="http://localhost:3000/api/videos/1/stream" type="video/mp4">
</video>
```

The video player will automatically send range requests. Server responds with `206 Partial Content`.

---

## Next Steps

1. **Read API-ENDPOINTS.md** for complete endpoint documentation
2. **Read FRONTEND-CHECKLIST.md** for implementation guidance
3. **Test authentication flow** using Swagger UI at `/docs`
4. **Start with Phase 1** features (authentication and setup)

## Support

- **API Documentation**: `/docs` (Swagger UI)
- **Health Check**: `/health`
- **Base URL**: `http://localhost:3000/api`
