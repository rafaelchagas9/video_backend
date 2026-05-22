# Settings API Documentation

Scope: `/api/settings`

## Integration notes

- All endpoints require authentication.
- Settings are exposed as key/value records.
- Update endpoint accepts a dictionary object, not an array.

## Endpoints

### GET /api/settings

- Success: `200` -> `{ success: true, data: Setting[] }`

### PATCH /api/settings

- Body:
  - `settings`: record of string keys to values
  - value types supported:
    - string
    - number
    - boolean
- Success: `200` -> `{ success: true, data: Setting[] }`
- Errors: `400`, `401`

## Setting model

- `key` string
- `value` string | number | boolean
- `updated_at` string

## Frontend cautions

1. Preserve type fidelity when editing settings; do not stringify everything blindly.
2. Treat returned settings array as source of truth after update rather than patching local state by guesswork.
