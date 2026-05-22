# Tags API Documentation

Scope: `/api/tags/*`

## Integration notes

- All endpoints require authentication.
- `GET /api/tags` supports flat/tree behavior with pagination metadata.
- `tree` query accepts boolean-ish value (`true`/`false`).

## Endpoints

### GET /api/tags

- Query:
  - `page` int > 0 (default 1)
  - `limit` int 1..100 (default 20)
  - `search` string optional
  - `sort` = `name | created_at` (default `name`)
  - `order` = `asc | desc` (default `asc`)
  - `tree` boolean (default false)
- Success: `200` -> `{ success: true, data: TagTreeNode[], pagination }`
- Errors: `401`

### GET /api/tags/:id

- Params: `id` positive int
- Success: `200` -> `{ success: true, data: TagWithPath }`
- Errors: `401`, `404`

### POST /api/tags

- Body: create tag payload (name/description/color/parent_id per `createTagSchema`)
- Success: `201` -> `{ success: true, data: Tag, message }`
- Errors: `400`, `401`

### PATCH /api/tags/:id

- Params: `id` positive int
- Body: partial update payload per `updateTagSchema`
- Success: `200` -> `{ success: true, data: Tag, message }`
- Errors: `400`, `401`, `404`

### DELETE /api/tags/:id

- Params: `id` positive int
- Success: `200` -> `{ success: true, message }`
- Errors: `401`, `404`

### GET /api/tags/:id/children

- Params: `id` positive int
- Success: `200` -> `{ success: true, data: Tag[] }`
- Errors: `401`, `404`

### GET /api/tags/:id/videos

- Params: `id` positive int
- Success: `200` -> `{ success: true, data: { id, file_name, title, duration_seconds }[] }`
- Errors: `401`, `404`
