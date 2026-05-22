# Auth API Documentation

Scope: `/api/auth/*`

## Integration notes

- Authentication is session-cookie based (`session_id`), not bearer token.
- Frontend must send `credentials: "include"` on all authenticated requests.
- Cookie is `HttpOnly`; frontend cannot read token directly.
- `POST /api/auth/register` is single-user bootstrapping and can be blocked after first account exists.

## Endpoints

### POST /api/auth/register

- Auth: Public
- Body:
  - `username` string (3..50)
  - `password` string (8..100)
- Success: `201` -> `{ success: true, data: User, message? }`
- Errors: `400`, `409`
- UI notes:
  - Treat `409` as "system already initialized / username conflict" depending on backend message.

### POST /api/auth/login

- Auth: Public
- Body:
  - `username` string (required)
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
  - `username` string
  - `created_at` string (ISO datetime)
  - `updated_at` string (ISO datetime)
- Error:
  - `{ success: false, error: { message: string, statusCode: number } }`
