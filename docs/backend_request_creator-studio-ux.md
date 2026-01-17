# Backend Requests — Creator/Studio UX Improvements

## Goals
- Enable fast creator/studio triage with search, filters, and completeness flags.
- Allow bulk assignment of platforms/socials + profile picture via URL.
- Support preview before applying bulk updates.

## Completeness Rules
Creator is complete if ALL:
- Has profile picture
- Has at least one platform profile OR at least one social link
- Has at least one linked video

Studio is complete if ALL:
- Has profile picture
- Has at least one social link
- Has at least one linked creator OR linked video

## List API Enhancements (Creators/Studios)
### Search
- `GET /creators?search=...` must match creator name OR platform username.
- `GET /studios?search=...` must match studio name.

### Filters
- `missing` filter to return incomplete/missing data:
  - `missing=picture`
  - `missing=platform` (creators only)
  - `missing=social`
  - `missing=linked` (creator -> videos, studio -> creators/videos)
  - `missing=any` (incomplete)
- `complete=true|false`

### Sorting
- `sort=name|created_at|updated_at|video_count|creator_count`
- `order=asc|desc`

### Response Fields (add to list items)
- `platform_count` (creators)
- `social_link_count`
- `linked_video_count`
- `linked_creator_count` (studios)
- `has_profile_picture`
- `completeness`: { `is_complete`, `missing_fields`: string[] }

## Bulk Create/Update for Platform/Social Links
- `POST /creators/:id/platforms/bulk`
  - body: `{ items: [{ platform_id, username, profile_url, is_primary? }] }`
- `POST /creators/:id/social-links/bulk`
  - body: `{ items: [{ platform, url }] }`
- `POST /studios/:id/social-links/bulk`
  - body: `{ items: [{ platform_name, url }] }`

Behavior:
- Upsert by unique key (`platform_id` + `username` or `platform` + `url`)
- Return created/updated rows and any errors

## Profile Picture from URL
- Allow setting profile picture by URL:
  - `POST /creators/:id/picture-from-url` (body: `{ url }`)
  - `POST /studios/:id/picture-from-url` (body: `{ url }`)
- Server downloads, validates, stores, returns updated entity

## Bulk Import with Preview (Creators/Studios)
We need a preview before applying.

Option A (recommended):
- `POST /creators/bulk?dry_run=true`
- `POST /creators/bulk`
- `POST /studios/bulk?dry_run=true`
- `POST /studios/bulk`

Payload example:
```
{
  "items": [
    {
      "id": 123,
      "name": "Creator Name",
      "profile_picture_url": "https://...",
      "platforms": [{ "platform_id": 2, "username": "foo", "profile_url": "..." }],
      "social_links": [{ "platform": "Twitter", "url": "..." }],
      "link_video_ids": [1,2,3]
    }
  ],
  "mode": "merge" // or "replace"
}
```

Preview response should include:
- Resolved entity id or “will create new”
- Validation errors
- Computed changes (fields to add/update)
- Missing dependencies

## Notes
- Search by platform username must include platforms join.
- `linked` completeness should check counts, not just existence of arrays.
