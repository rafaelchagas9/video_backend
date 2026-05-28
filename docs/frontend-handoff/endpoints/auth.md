# Auth API Documentation

Scope: `/api/auth/*`

## Integration notes

- Authentication is Better Auth-backed and session-cookie based (`session_id`), not bearer token.
- Frontend must send `credentials: "include"` on all authenticated requests.
- Cookie is `HttpOnly`; frontend cannot read token directly.
- Better Auth native endpoints are also exposed under `/api/auth/*` for future frontend adoption.

## Endpoints

### POST /api/auth/register

- Auth: Public
- Body:
  - `email` string (valid email)
  - `name` string (optional)
  - `password` string (8..100)
- Success: `201` -> `{ success: true, data: User, message? }`
- Errors: `400`, `409`
- UI notes:
  - Treat `409` as "email already exists".

### POST /api/auth/login

- Auth: Public
- Body:
  - `email` string (preferred)
  - `username` string (legacy fallback for migrated accounts)
  - `password` string (required)
- Success: `200` -> `{ success: true, data: User, message? }` + sets `session_id` cookie
- Errors: `400`, `401`
- UI notes:
  - After login, immediately call `GET /api/auth/me` to hydrate session state.

### POST /api/auth/logout

- Auth: Required
- Success: `200` -> `{ success: true, message }` + clears cookie
- Errors: `401`
- UI notes:
  - Always clear local auth state even if request fails with expired session.

### GET /api/auth/me

- Auth: Required
- Success: `200` -> `{ success: true, data: User }`
- Errors: `401`
- UI notes:
  - Use as app bootstrap endpoint.

## Shared response shapes

- `User`:
  - `id` number
  - `name` string
  - `email` string
  - `email_verified` boolean
  - `image` string | null
  - `username` string | null
  - `created_at` string (ISO datetime)
  - `updated_at` string (ISO datetime)
- Error:
  - `{ success: false, error: { message: string, statusCode: number } }`
