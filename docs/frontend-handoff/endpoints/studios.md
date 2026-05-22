# Studios API Documentation

Scope: `/api/studios/*`

## Integration notes

- All endpoints require authentication.
- This module mirrors much of `creators`, but focuses on:
  - CRUD
  - profile picture handling
  - social links
  - creator relationships
  - video relationships
  - bulk import with preview mode
  - autocomplete/recent/quick-create

## Core studio model

- `id`
- `name`
- `description`
- `profile_picture_path`
- `profile_picture_url`
- `created_at`
- `updated_at`
- Optional enhanced fields:
  - `social_link_count`
  - `linked_video_count`
  - `linked_creator_count`
  - `has_profile_picture`
  - `completeness: { is_complete, missing_fields[] }`

## 1) CRUD and listing

### GET /api/studios

#### Query

- `page` positive int, default `1`
- `limit` positive int <= `100`, default `20`
- `search` string optional
- `sort` = `name | created_at | updated_at | video_count | creator_count`
- `order` = `asc | desc`, default `asc`
- `missing` = `picture | social | linked | any`
- `complete` boolean optional

#### Success

- `200` -> `{ success: true, data: Studio[], pagination? }`

### GET /api/studios/:id

- Success: `200` -> `{ success: true, data: Studio }`
- Errors: `401`, `404`

### POST /api/studios

- Body:
  - `name` string 1..255
  - `description` string <= 2000 optional
- Success: `201` -> `{ success: true, data: Studio, message }`

### PATCH /api/studios/:id

- Body:
  - `name` optional
  - `description` optional, nullable
- Success: `200` -> `{ success: true, data: Studio, message }`

### DELETE /api/studios/:id

- Success: `200` -> `{ success: true, message }`

## 2) Profile picture handling

### POST /api/studios/:id/picture

- Content-Type: `multipart/form-data`
- Body: uploaded image file
- Success: `200` -> `{ success: true, data: Studio, message }`
- Errors: `400` when no file provided

### GET /api/studios/:id/picture

- Success: `200` image bytes

#### Important behavior

- If no picture exists, backend serves default `studio.png`.

### DELETE /api/studios/:id/picture

- Success: `200` -> `{ success: true, data: Studio, message }`

### POST /api/studios/:id/picture-from-url

- Body:
  - `url` valid URL
- Success: `200` -> `{ success: true, data: Studio, message }`

## 3) Social links

### POST /api/studios/:id/social-links

- Body:
  - `platform_name` string 1..50
  - `url` valid URL
- Success: `201` -> `{ success: true, data: SocialLink, message }`

### GET /api/studios/:id/social-links

- Success: `200` -> `{ success: true, data: SocialLink[] }`

### PATCH /api/studios/:id/social-links/:linkId

- Body:
  - `platform_name` optional
  - `url` optional
- Success: `200` -> `{ success: true, data: SocialLink, message }`

### DELETE /api/studios/:id/social-links/:linkId

- Success: `200` -> `{ success: true, message }`

### POST /api/studios/:id/social-links/bulk

- Body:
  - `items: [{ platform_name, url }]`
  - min 1, max 50
- Success: `200` -> `{ success: true, data: { created, updated, errors }, message }`

## 4) Creator relationships

### POST /api/studios/:id/creators/bulk

- Body:
  - `creatorIds` positive int[]
  - `action` = `add | remove`
- Success: `200` -> `{ success: true, message }`

### POST /api/studios/:id/creators/:creatorId

- Success: `200` -> `{ success: true, message }`

### GET /api/studios/:id/creators

- Success: `200` -> `{ success: true, data: Creator[] }`

### DELETE /api/studios/:id/creators/:creatorId

- Success: `200` -> `{ success: true, message }`

## 5) Video relationships

### POST /api/studios/:id/videos/:videoId

- Success: `200` -> `{ success: true, message }`

### GET /api/studios/:id/videos

- Success: `200` -> `{ success: true, data: Video[] }`
- Returned videos are lighter than main `/api/videos` list but may include `thumbnail_id` and `thumbnail_url`.

### DELETE /api/studios/:id/videos/:videoId

- Success: `200` -> `{ success: true, message }`

## 6) Bulk import

### POST /api/studios/bulk

- Query:
  - `dry_run` boolean, default false
- Body:
  - `items` array 1..100
  - `mode` = `merge | replace`, default `merge`

#### Bulk item shape

- `id` optional
- `name` required
- `description` optional
- `profile_picture_url` optional
- `social_links` optional
- `link_creator_ids` optional
- `link_video_ids` optional

#### Success

- `200` -> `{ success: true, data: { dry_run, items, summary }, message }`

#### Notes

- Response exposes preview details for create/update intent, validation issues, and relationship deltas.

## 7) Search helper flows

### GET /api/studios/autocomplete

- Query:
  - `q` string 1..100
  - `limit` positive int <= 50, default 10
- Success: `200` -> `{ success: true, data: Studio[] }`

### GET /api/studios/recent

- Query:
  - `limit` positive int <= 50, default 10
- Success: `200` -> `{ success: true, data: Studio[] }`

### POST /api/studios/quick-create

- Body:
  - `name` string 1..255
  - `description` optional
- Success: `201` -> `{ success: true, data: Studio, message }`
- Errors: `400`, `401`, `409`

## Frontend cautions

1. `studios` is highly relationship-oriented; creator/video linking will likely be the main UI workload.
2. Keep bulk social-link upsert and bulk creator updates separate in UI; they solve different workflows.
3. Default image fallback means avatar rendering can be direct from endpoint without null checks.
4. `bulk` import preview mode is useful for admin tools and should not be mixed into ordinary CRUD screens.
