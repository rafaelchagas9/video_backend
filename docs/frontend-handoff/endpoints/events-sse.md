# Events (SSE) API Documentation

Scope: `/api/events/stream`

## Endpoint

### GET /api/events/stream

- Auth: Required (`session_id` cookie)
- Content-Type: `text/event-stream`
- Transport notes:
  - Keepalive comments every ~20s (`: keepalive`)
  - Session revalidation every ~30s
  - On invalid session, server emits `auth:expired` and closes stream

## SSE frame format

- Event name in SSE frame: `event: <type>`
- Data payload in SSE frame:
  - `data: { "type": string, "message": unknown, "timestamp": string }`

## Known event types in current backend

- `conversion:started`
- `conversion:progress`
- `conversion:completed`
- `conversion:failed`
- `conversion:batch_completed`
- `storyboard:generating`
- `storyboard:ready`
- `storyboard:error`
- `face:extraction_started`
- `face:extraction_complete`
- `face:extraction_error`
- `auth:expired`

## Frontend handling checklist

- Open stream only after auth bootstrap succeeds.
- Reconnect with backoff when connection drops unexpectedly.
- On `auth:expired`, stop reconnect loop and redirect to login.
- Keep event handling centralized (event bus/store) to avoid duplicate listeners.
