# Multiplayer Remote Control Implementation Plan

## Scope

Implement backend support for multiplayer remote control between:

- A web display client that owns playback and UI state.
- A mobile remote client that pairs with the display and sends commands.

Agreed product constraints for v1:

- Single remote only.
- One-time pairing code.
- Manual display approval required after code entry.
- Same authenticated user only.
- Database-backed session persistence from the start.
- Mobile can update randomization filters.
- Existing websocket file can be discarded.
- Tests are not a priority for the first pass.

## Architecture Summary

- New backend module: `src/modules/multiplayer-remote/`
- HTTP endpoints for lifecycle, pairing, approval, close, and state fetch
- Dedicated websocket endpoint for realtime traffic
- Backend owns session lifecycle, pairing, authorization, validation, and routing
- Web display remains source of truth for actual playback and final UI state
- Backend persists latest session snapshot for reconnect recovery

## Product Decisions

### Session Rules

- A session is created by the authenticated web display user.
- A session is only available while the display client is connected.
- If the display disconnects, the session is closed immediately.
- Only one remote may be active in a session at a time.
- Pairing code is one-time-use and invalidated after approval.
- Remote user must match the session owner user.

### Approval Rules

- Mobile submits the pairing code through HTTP.
- Backend creates a pending join request and notifies the display.
- Display receives requester metadata and manually approves or rejects.
- Approval is required before the remote websocket connection becomes active.

### State Rules

- Backend stores the latest session snapshot as JSON.
- Display publishes fresh state after connect and after each successful mutation.
- Remote reconnects recover from the stored snapshot.
- Backend does not attempt to independently calculate playback truth.

## Proposed File Structure

```text
src/modules/multiplayer-remote/
  multiplayer-remote.types.ts
  multiplayer-remote.schemas.ts
  multiplayer-remote.service.ts
  multiplayer-remote.routes.ts
  multiplayer-remote.websocket.ts
```

Potential schema files:

```text
src/database/schema/multiplayer-remote.schema.ts
```

## Database Design

### Table: `multiplayer_remote_sessions`

Purpose:
Persist session lifecycle, ownership, connection state, pairing state, and last known display snapshot.

Suggested columns:

- `id`
- `owner_user_id`
- `display_client_id`
- `remote_client_id`
- `pairing_code`
- `pairing_code_expires_at`
- `status`
- `display_connected_at`
- `display_last_seen_at`
- `remote_connected_at`
- `remote_last_seen_at`
- `approved_at`
- `closed_at`
- `close_reason`
- `last_state_json`
- `protocol_version`
- `created_at`
- `updated_at`

Suggested statuses:

- `waiting_for_remote`
- `pending_approval`
- `active`
- `closed`
- `expired`

### Table: `multiplayer_remote_join_requests`

Purpose:
Track pairing attempts that require manual display approval.

Suggested columns:

- `id`
- `session_id`
- `requesting_user_id`
- `requesting_session_id`
- `status`
- `requested_code`
- `remote_device_name`
- `remote_device_type`
- `remote_user_agent`
- `expires_at`
- `resolved_at`
- `created_at`
- `updated_at`

Suggested statuses:

- `pending`
- `approved`
- `rejected`
- `expired`
- `cancelled`

## API Design

Base prefix:

- `/api/multiplayer-remote`

### HTTP Endpoints

#### `POST /sessions`

Creates a remote-control session for the authenticated display user.

Returns:

- `sessionId`
- `pairingCode`
- `pairingCodeExpiresAt`
- initial session metadata

#### `GET /sessions/:id`

Returns:

- session metadata
- connection status
- latest stored snapshot
- pending join request summary when applicable

#### `POST /sessions/:id/close`

Closes an active or pending session.

#### `POST /pair`

Accepts a pairing code from the mobile client and creates a pending join request.

Validations:

- authenticated user only
- same user as session owner
- code exists
- code not expired
- session active and display connected
- no active remote already attached

#### `GET /sessions/:id/join-requests/pending`

Allows the display client to fetch the current pending approval request if needed.

#### `POST /sessions/:id/join-requests/:requestId/approve`

Approves the pending request, activates the remote session, and invalidates the pairing code.

#### `POST /sessions/:id/join-requests/:requestId/reject`

Rejects the pending request and returns the session to `waiting_for_remote`.

### WebSocket Endpoint

#### `GET /ws`

Dedicated websocket endpoint under the multiplayer module prefix.

Expected first client event:

- `client.hello`

Payload should include:

- `sessionId`
- `role`
- `protocolVersion`
- optional `clientInfo`

Supported roles:

- `display`
- `remote`

## Event Protocol

All websocket messages should use a stable envelope with:

- `event`
- `payload`
- `timestamp`
- `protocolVersion`
- optional `sessionId`
- optional `commandId`

### Core Events

- `client.hello`
- `client.connected`
- `client.disconnected`
- `session.created`
- `session.state`
- `session.join_requested`
- `session.join_approved`
- `session.join_rejected`
- `session.closed`
- `command.request`
- `command.ack`
- `command.rejected`
- `command.failed`
- `playback.state`

## Command Model

Use a generic `command.request` envelope with typed command names and validated arguments.

Suggested initial commands:

- `slots.add_videos`
- `slots.remove`
- `slots.clear`
- `slots.reorder`
- `slots.randomize_all`
- `slots.randomize_one`
- `playback.play_all`
- `playback.pause_all`
- `playback.play_slot`
- `playback.pause_slot`
- `audio.mute_all`
- `audio.unmute_all`
- `audio.mute_slot`
- `audio.unmute_slot`
- `audio.set_all_volume`
- `audio.set_slot_volume`
- `layout.set_mode`
- `layout.set_slot_size`
- `layout.reset_slot_size`
- `selection.set_active_slot`
- `filters.update`
- `filters.reset`

Validation approach:

- Use a discriminated Zod union keyed by command type.
- Validate command payloads server-side before routing them to display.

## Session State Snapshot

Persist the latest display-reported snapshot in `last_state_json`.

Suggested shape:

- `sessionId`
- `status`
- `layoutMode`
- `slots`
- `slotOrder`
- `activeSlotId`
- `filters`
- `updatedAt`

Suggested slot fields:

- `slotId`
- `videoId`
- `title`
- `thumbnailUrl`
- `muted`
- `playing`
- `size`

## Realtime Flow

### Display Flow

1. Display creates session through HTTP.
2. Display connects to websocket as role `display`.
3. Display sends initial `session.state`.
4. Display receives join requests and command requests.
5. Display sends `command.ack` or `command.failed`.
6. Display sends updated `session.state` after each successful mutation.

### Remote Flow

1. Remote submits pairing code through HTTP.
2. Remote waits for display approval.
3. After approval, remote connects to websocket as role `remote`.
4. Remote receives latest session snapshot.
5. Remote sends `command.request` messages.
6. Remote receives acks, rejections, failures, and state updates.

## Authorization And Safety

- Require authenticated user for all lifecycle endpoints.
- Require authenticated user for websocket access.
- Enforce same-user pairing.
- Reject commands for sessions the client is not attached to.
- Rate-limit pairing attempts.
- Expire unused pairing codes.
- Expire stale pending join requests.
- Reject protocol-version mismatches with a clear event or error response.

## Operational Rules

- Pairing code format: 6 uppercase alphanumeric characters
- Pairing code TTL: 5 minutes
- Pending approval TTL: 2 minutes
- Protocol version: `1`
- Heartbeat interval: 20 to 30 seconds
- Session closes immediately when display disconnects

## Phases

### Phase 1: Data Model And Contracts

Goal:
Define persistent schema and shared backend contracts.

Tasks:

- Create `multiplayer_remote_sessions` schema.
- Create `multiplayer_remote_join_requests` schema.
- Export new schema from `src/database/schema/index.ts`.
- Wire new relations in `src/database/schema/relations.ts`.
- Generate Drizzle migration with `bun db:generate`.
- Review generated migration SQL for safety.
- Define core types for session, join request, client roles, statuses, snapshot, and event envelope.
- Define Zod schemas for HTTP payloads and websocket messages.

Checklist:

- [x] Session table schema added
- [x] Join request table schema added
- [x] Barrel exports updated
- [x] Relations updated
- [x] Migration generated
- [x] Migration SQL reviewed
- [x] Core types added
- [x] Zod schemas added

Implementation notes:

- Migration generated as `src/database/drizzle-migrations/0017_high_barracuda.sql`.
- Migration was applied with `bun db:migrate` after review and completed without errors.
- Command validation was defined as a discriminated Zod union for the initial command list.

### Phase 2: Session Lifecycle HTTP API

Goal:
Implement session creation, lookup, pairing, approval, rejection, and close flows.

Tasks:

- Add `multiplayer-remote.service.ts` with lifecycle operations.
- Implement session creation with pairing code generation and expiry.
- Implement same-user code pairing and pending join request creation.
- Implement session lookup with latest snapshot and status.
- Implement approve join request flow.
- Implement reject join request flow.
- Implement explicit close session flow.
- Add route registration in `src/server.ts`.
- Add OpenAPI metadata for the new endpoints.

Checklist:

- [x] Service skeleton created
- [x] Create session endpoint implemented
- [x] Get session endpoint implemented
- [x] Pair endpoint implemented
- [x] Approve endpoint implemented
- [x] Reject endpoint implemented
- [x] Close endpoint implemented
- [x] Routes registered in server
- [x] Swagger docs visible

Implementation notes:

- HTTP routes are registered under `/api/multiplayer-remote`.
- Pairing now requires an authenticated same-user request and a connected display websocket.
- Approval invalidates the pairing code and moves the session to `active`.
- Rejection leaves the session in `waiting_for_remote`; the existing pairing code remains usable until its original expiry.

### Phase 3: WebSocket Transport

Goal:
Add a dedicated realtime transport for display and remote clients.

Tasks:

- Register `@fastify/websocket` if not already registered for this path.
- Add multiplayer websocket endpoint.
- Authenticate websocket connections using existing session cookies.
- Implement `client.hello` handshake.
- Bind connections to session and role.
- Enforce single display and single remote rules.
- Add heartbeat and disconnect cleanup.
- Close session immediately on display disconnect.

Checklist:

- [x] Websocket route added
- [x] Authenticated handshake implemented
- [x] Role binding implemented
- [x] Single display enforcement added
- [x] Single remote enforcement added
- [x] Heartbeat added
- [x] Disconnect cleanup added
- [x] Display disconnect closes session

Implementation notes:

- Websocket route is available at `/api/multiplayer-remote/ws`.
- First client message must be `client.hello`.
- Remote websocket binding is blocked until approval has moved the session to `active`.
- Display disconnect closes the persisted session immediately with `close_reason = 'display_disconnected'`.

### Phase 4: Approval And Routing

Goal:
Connect pending approval to realtime notifications and command routing.

Tasks:

- Notify display when a pending join request is created.
- Notify remote when join request is approved or rejected.
- Forward validated `command.request` events from remote to display.
- Block remote command traffic until approval is complete.
- Add `command.rejected` for invalid role/session/state cases.
- Add `command.ack` and `command.failed` passthrough support from display.

Checklist:

- [x] Join request realtime notification added
- [x] Approval notification added
- [x] Rejection notification added
- [x] Command forwarding added
- [x] Pre-approval command blocking added
- [x] Command rejection events added
- [x] Ack and failure passthrough added

Implementation notes:

- `POST /pair` now notifies the connected display with `session.join_requested`.
- Approval and rejection HTTP flows emit `session.join_approved` and `session.join_rejected` to connected clients when present.
- Remote `command.request` messages are validated with the command discriminated union, require an approved active session, and are forwarded to the display.
- Display `command.ack` and `command.failed` messages are validated and forwarded to the active remote.
- Invalid role, session, disconnected-display, and unsupported-event cases return `command.rejected`.

### Phase 5: State Persistence And Reconnect Recovery

Goal:
Persist display state snapshots and support reconnect recovery.

Tasks:

- Accept `session.state` updates from display.
- Validate and persist `last_state_json`.
- Broadcast updated state to the active remote.
- Return stored snapshot from `GET /sessions/:id`.
- Send stored snapshot to approved remote on websocket connect.
- Decide how session behaves when remote disconnects and reconnects.

Checklist:

- [x] Display state updates accepted
- [x] Snapshot validation added
- [x] Snapshot persistence added
- [x] Snapshot broadcast added
- [x] HTTP state recovery added
- [x] Websocket reconnect recovery added
- [x] Remote reconnect behavior finalized in code

Implementation notes:

- Display `session.state` websocket messages are validated with `sessionSnapshotSchema`, persisted to `last_state_json`, and broadcast to the active remote.
- `GET /sessions/:id` already returns `lastState`, so HTTP recovery uses the stored snapshot.
- Approved remote websocket connections receive the stored snapshot immediately after `client.connected`.
- Remote disconnect leaves the approved session active, clears `remote_client_id`, and allows the same approved user/session to reconnect without a new pairing flow while the display remains connected.

### Phase 6: Hardening And Cleanup

Goal:
Make the feature safe, maintainable, and ready for frontend integration.

Tasks:

- Add rate limiting for pairing attempts.
- Add expiration handling for pairing codes and join requests.
- Add protocol version mismatch handling.
- Add structured logging around session lifecycle and routing failures.
- Remove or replace the old unused websocket implementation.
- Verify module naming, route prefixing, and error semantics are consistent with the codebase.

Checklist:

- [x] Pairing rate limiting added
- [x] Expiration handling added
- [x] Protocol mismatch handling added
- [x] Structured logging added
- [x] Old websocket code removed or retired
- [x] Consistency pass completed

Implementation notes:

- `POST /pair` now has a focused route-level rate limit of 10 requests per minute.
- Stale pending join requests are marked `expired` before lookup, pairing, approval, display binding, or remote binding. If the session was in `pending_approval`, it returns to `waiting_for_remote`.
- Pairing-code expiry continues to mark unused sessions as `expired` when a stale code is submitted.
- Websocket messages reject unsupported protocol versions with an explicit protocol-version error before schema validation.
- Lifecycle/routing logs now cover join notifications, approval/rejection notifications, state persistence, command forwarding, and command result forwarding.
- Explicit user closes and display disconnects emit `session.closed` to connected clients and close active multiplayer sockets.
- The unused legacy `src/modules/websocket/websocket.ts` service was removed; multiplayer realtime traffic is handled by `/api/multiplayer-remote/ws`.

## Open Follow-Up Items

These do not block backend v1 but may need product follow-up:

- Whether rejected approvals should keep the same display session or rotate the pairing code
- Whether remote disconnect should require a full new pairing flow every time
- Whether to expose richer device metadata from mobile
- Whether to later persist command history for debugging or replay

## Progress Tracker

- [x] Phase 1 complete
- [x] Phase 2 complete
- [x] Phase 3 complete
- [x] Phase 4 complete
- [x] Phase 5 complete
- [x] Phase 6 complete
