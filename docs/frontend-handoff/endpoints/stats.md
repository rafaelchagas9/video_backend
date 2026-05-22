# Stats API Documentation

Scope: `/api/stats/*`

## Integration notes

- All endpoints require authentication.
- Stats are grouped into four domains:
  - storage
  - library
  - content
  - usage
- Each domain has:
  - current stats endpoint
  - history endpoint
  - manual snapshot endpoint
- History endpoints share the same query schema.

## Shared history query

- `days` number 1..365, default `30`
- `limit` number 1..1000, default `100`

## Storage

### GET /api/stats/storage
- Success: current storage stats with directory breakdown and managed size totals

### GET /api/stats/storage/history
- Query: shared history query
- Success: storage snapshot array

### POST /api/stats/storage/snapshot
- Success: `201` -> storage snapshot + message

## Library

### GET /api/stats/library
- Success: current library stats including:
  - total/available/unavailable counts
  - total/average size
  - total/average duration
  - resolution breakdown
  - codec breakdown

### GET /api/stats/library/history
- Query: shared history query

### POST /api/stats/library/snapshot
- Success: `201` snapshot + message

## Content

### GET /api/stats/content
- Success: content organization stats including:
  - videos without tags/creators/ratings/thumbnails/storyboards
  - total tags/creators/studios/playlists
  - top tags
  - top creators

### GET /api/stats/content/history
- Query: shared history query

### POST /api/stats/content/snapshot
- Success: `201` snapshot + message

## Usage

### GET /api/stats/usage
- Success: usage/watch stats including:
  - total watch time
  - total play count
  - unique videos watched
  - videos never watched
  - average completion rate
  - top watched videos
  - activity by hour

### GET /api/stats/usage/history
- Query: shared history query

### POST /api/stats/usage/snapshot
- Success: `201` snapshot + message

## Combined operation

### POST /api/stats/snapshot
- Success: `201` -> `{ success: true, data: { storage, library, content, usage }, message }`

## Frontend cautions

1. Build stats pages by domain; don’t wait for all domains if one panel fails.
2. History endpoints are graph-friendly and should likely be normalized client-side.
3. Snapshot endpoints are admin/maintenance actions, not routine page loads.
