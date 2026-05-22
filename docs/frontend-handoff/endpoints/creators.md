# Creators API Documentation

Scope: `/api/creators/*`

## Integration notes

- All endpoints require authentication.
- This module supports:
  - CRUD
  - paginated filtering
  - bulk import with `dry_run`
  - profile picture upload/download
  - platform profiles
  - social links
  - creator-studio relationships
  - autocomplete/recent/quick-create flows
- `GET /api/creators/:id/picture` can return profile picture, face thumbnail, or fallback image.
- Some creator responses include computed completeness/count fields.

## Core creator model

- `id`
- `name`
- `description`
- `profile_picture_path`
- `face_thumbnail_path`
- `profile_picture_url`
- `face_thumbnail_url`
- `created_at`
- `updated_at`
- Optional enhanced fields on list/autocomplete/recent:
  - `platform_count`
  - `social_link_count`
  - `linked_video_count`
  - `has_profile_picture`
  - `completeness: { is_complete, missing_fields[] }`

## 1) CRUD and listing

### GET /api/creators

#### Query

- `page` positive int, default `1`
- `limit` positive int <= `100`, default `20`
- `search` string optional
- `sort` = `name | created_at | updated_at | video_count`, default `name`
- `order` = `asc | desc`, default `asc`
- `minVideoCount` int >= 0 optional
- `maxVideoCount` int >= 0 optional
- `hasProfilePicture` boolean optional
- `studioIds` comma-separated ids or array optional
- `missing` = `picture | platform | social | linked | any`
- `complete` boolean optional

#### Success

- `200` -> `{ success: true, data: Creator[], pagination }`

#### Errors

- `401`
- validation error when `minVideoCount > maxVideoCount`

### GET /api/creators/:id

- Success: `200` -> `{ success: true, data: Creator }`
- Errors: `401`, `404`

### POST /api/creators

- Body:
  - `name` string 1..255
  - `description` string <= 2000 optional
- Success: `201` -> `{ success: true, data: Creator, message }`
- Errors: `400`, `401`

### PATCH /api/creators/:id

- Body:
  - `name` optional
  - `description` optional, nullable
- Success: `200` -> `{ success: true, data: Creator, message }`
- Errors: `400`, `401`, `404`

### DELETE /api/creators/:id

- Success: `200` -> `{ success: true, message }`
- Errors: `401`, `404`

### GET /api/creators/:id/videos

- Success: `200` -> `{ success: true, data: Video[] }`
- Video fields are lighter than the main videos module.

## 2) Profile picture handling

### POST /api/creators/:id/picture

- Content-Type: `multipart/form-data`
- Body: uploaded image file
- Success: `200` -> `{ success: true, data: Creator, message }`
- Errors: `400` when no file provided

### GET /api/creators/:id/picture

- Query:
  - `type=face` optional
- Success: `200` image bytes

#### Important behavior

- `type=face` prefers `face_thumbnail_path`, then profile picture, then fallback avatar.
- Without `type=face`, backend prefers profile picture, then face thumbnail, then fallback avatar.
- Frontend can use this directly in `<img src>`.

### DELETE /api/creators/:id/picture

- Success: `200` -> `{ success: true, data: Creator, message }`

### POST /api/creators/:id/picture-from-url

- Body:
  - `url` valid URL
- Success: `200` -> `{ success: true, data: Creator, message }`

## 3) Platform profiles

These are creator-platform identities, distinct from generic social links.

### POST /api/creators/:id/platforms

- Body:
  - `platform_id` positive int
  - `username` string 1..100
  - `profile_url` valid URL
  - `is_primary` boolean, default false
- Success: `201` -> `{ success: true, data: PlatformProfile, message }`

### GET /api/creators/:id/platforms

- Success: `200` -> `{ success: true, data: PlatformProfile[] }`

### PATCH /api/creators/:id/platforms/:platformId

- Body:
  - `username` optional
  - `profile_url` optional
  - `is_primary` optional
- Success: `200` -> `{ success: true, data: PlatformProfile, message }`

### DELETE /api/creators/:id/platforms/:platformId

- Success: `200` -> `{ success: true, message }`

### POST /api/creators/:id/platforms/bulk

- Body:
  - `items: [{ platform_id, username, profile_url, is_primary? }]`
  - min 1, max 50
- Success: `200` -> `{ success: true, data: { created, updated, errors }, message }`

## 4) Social links

### POST /api/creators/:id/social-links

- Body:
  - `platform_name` string 1..50
  - `url` valid URL
- Success: `201` -> `{ success: true, data: SocialLink, message }`

### GET /api/creators/:id/social-links

- Success: `200` -> `{ success: true, data: SocialLink[] }`

### PATCH /api/creators/:id/social-links/:linkId

- Body:
  - `platform_name` optional
  - `url` optional
- Success: `200` -> `{ success: true, data: SocialLink, message }`

### DELETE /api/creators/:id/social-links/:linkId

- Success: `200` -> `{ success: true, message }`

### POST /api/creators/:id/social-links/bulk

- Body:
  - `items: [{ platform_name, url }]`
  - min 1, max 50
- Success: `200` -> `{ success: true, data: { created, updated, errors }, message }`

## 5) Studio relationships

### POST /api/creators/:id/studios/:studioId

- Success: `200` -> `{ success: true, message }`

### GET /api/creators/:id/studios

- Success: `200` -> `{ success: true, data: Studio[] }`

### DELETE /api/creators/:id/studios/:studioId

- Success: `200` -> `{ success: true, message }`

## 6) Bulk import

### POST /api/creators/bulk

- Query:
  - `dry_run` boolean, default false
- Body:
  - `items` array 1..1000
  - `mode` = `merge | replace`, default `merge`

#### Bulk item shape

- `id` optional
- `name` required
- `description` optional
- `profile_picture_url` optional
- `platforms` optional
- `social_links` optional
- `link_video_ids` optional

#### Success

- `200` -> `{ success: true, data: { dry_run, items, summary }, message }`

#### Notes

- `dry_run=true` is ideal for admin/import preview UX.
- Response includes per-item preview details, validation errors, dependency issues, and change counts.

## 7) Search helper flows

### GET /api/creators/autocomplete

- Query:
  - `q` string 1..100
  - `limit` positive int <= 50, default 10
- Success: `200` -> `{ success: true, data: Creator[] }`

### GET /api/creators/recent

- Query:
  - `limit` positive int <= 50, default 10
- Success: `200` -> `{ success: true, data: Creator[] }`

### POST /api/creators/quick-create

- Body:
  - `name` string 1..255
  - `description` optional
- Success: `201` -> `{ success: true, data: Creator, message }`
- Errors: `400`, `401`, `409`

## Frontend cautions

1. Distinguish platform profiles from social links in UI and API client code.
2. Use direct image endpoints for avatar rendering instead of assuming `profile_picture_url` is always present.
3. `bulk` import is an admin workflow and should likely live behind a specialized screen.
4. Completeness and counts are excellent for badges/filters but may not exist on every creator payload.
5. Quick-create and autocomplete are ideal for tagging/modals and should avoid full creator-form overhead.
