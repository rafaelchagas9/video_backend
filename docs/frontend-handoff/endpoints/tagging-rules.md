# Tagging Rules API Documentation

Scope: `/api/tagging-rules/*`

## Integration notes

- All endpoints require authentication.
- Rules are condition/action based and can be tested before apply.
- `/apply` supports `dry_run` and optional `video_ids` targeting.

## Endpoints

### GET /api/tagging-rules

- Query:
  - `include_disabled` boolean (default false)
- Success: `200` -> `{ success: true, data: TaggingRule[] }`
- Errors: `401`

### GET /api/tagging-rules/:id

- Params: `id` positive int
- Success: `200` -> `{ success: true, data: TaggingRule }`
- Errors: `401`, `404`

### POST /api/tagging-rules

- Body:
  - `name` string
  - `description` optional
  - `rule_type` = `path_match | metadata_match | manual`
  - `is_enabled` boolean
  - `priority` int
  - `conditions` optional array
  - `actions` optional array (min 1 when present)
- Success: `201` -> `{ success: true, data: TaggingRule, message }`
- Errors: `400`, `401`, `409`

### PATCH /api/tagging-rules/:id

- Params: `id` positive int
- Body: partial update of name/description/rule_type/is_enabled/priority
- Success: `200` -> `{ success: true, data: TaggingRule, message }`
- Errors: `400`, `401`, `404`

### DELETE /api/tagging-rules/:id

- Params: `id` positive int
- Success: `200` -> `{ success: true, message }`
- Errors: `401`, `404`

### POST /api/tagging-rules/bulk/delete

- Body:
  - `ids` number[] (min 1)
- Success: `200` -> `{ success: true, data: { deleted }, message }`
- Errors: `400`, `401`

### POST /api/tagging-rules/:id/test

- Params: `id` positive int
- Query:
  - `limit` int 1..100 (default 10)
- Success: `200` -> `{ success: true, data: { matched, sample_matches[] } }`
- Errors: `401`, `404`

### POST /api/tagging-rules/apply

- Body:
  - `video_ids` optional number[]
  - `dry_run` boolean (default false)
  - `limit` int 1..1000 (default 100)
- Success: `200` -> `{ success: true, data: { processed, tagged, errors, details } }`
- Errors: `401`
