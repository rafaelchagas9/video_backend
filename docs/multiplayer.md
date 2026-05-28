# Multiplayer Remote Control Handoff

## Goal

We want the web multiplayer page to support a mobile remote-control flow.

The web app will open the multiplayer page, create a remote session, and display a short pairing code. A user will enter that code in the mobile app. Once paired, the mobile app should be able to control the web multiplayer experience: add videos, remove videos, pause/play videos, mute/unmute, randomize, change layout, and perform the same core actions currently available directly in the web multiplayer UI.

We want to use WebSockets for this feature so both clients can exchange state and commands in real time.

## Current Frontend Behavior

The existing web multiplayer page is local-only. It manages state in the browser for:

- Active video slots.
- Slot order.
- Selected/active slot.
- Play/pause state.
- Mute state.
- Layout mode: auto, 2x2, 3x3, 4x4.
- Random video selection.
- Random filters.
- Slot removal and clearing all slots.
- Slot randomization.
- Slot sizing in auto layout.

The mobile app already has access to the shared API client and can browse/search/select videos, but it does not currently control a web playback session.

## Backend Responsibility

The backend should own the remote session lifecycle, pairing, authorization, command validation, and real-time message routing.

This should not be frontend-only because the web and mobile clients are separate devices. The backend needs to be the trusted coordinator between them.

## Required Backend Features

### Remote Session Lifecycle

Backend should support creating a remote multiplayer session from the web app.

Expected behavior:

- Web creates a session.
- Backend returns a session id and short human-entered pairing code.
- Pairing code should be temporary and expire after a short period.
- Session should remain active while the web display client is connected.
- Session should become unavailable when the web display disconnects or explicitly closes it.
- Backend should expose enough state for clients to recover after reconnecting.

### Pairing

Mobile should be able to join a session by entering the pairing code.

Expected behavior:

- Mobile submits a code.
- Backend validates that the code exists, is not expired, and belongs to an active web display session.
- Backend associates the mobile connection with that session.
- Backend rejects invalid, expired, or already-closed sessions with clear error messages.

Open product decision for backend/frontend alignment:

- Whether multiple mobile remotes can join the same session.
- Whether a session code can be reused after one remote joins.
- Whether the web display needs to approve a mobile device before it can control playback.

### WebSocket Connections

Backend should provide WebSocket support for both roles:

- Display client: the web multiplayer page.
- Remote client: the mobile app.

Expected behavior:

- Both clients authenticate using the existing auth/session model.
- Each connection identifies its role and session.
- Backend broadcasts session state updates to all connected clients in the session.
- Backend routes remote commands from mobile to the web display.
- Backend routes display acknowledgements/state changes back to mobile.
- Backend handles reconnects without losing the latest known session state.

### Commands To Support

The backend should define and validate a command contract for the remote feature.

At minimum, mobile should be able to request:

- Add one or more videos to the multiplayer grid.
- Remove a specific slot.
- Clear all slots.
- Play or pause all videos.
- Play or pause a specific slot.
- Mute or unmute all videos.
- Mute or unmute a specific slot.
- Randomize all videos.
- Randomize a specific slot.
- Change layout mode.
- Reorder slots.
- Adjust/reset slot sizing for auto layout.
- Select/focus a slot if we decide to expose that behavior remotely.

The command model should be extensible so new multiplayer actions can be added without changing the transport design.

### State Synchronization

The backend should maintain or relay enough state for mobile to show the current session accurately.

Expected state includes:

- Session id.
- Connected display status.
- Connected remote status/count.
- Current slots.
- Slot ids.
- Video ids and basic video metadata needed by the mobile remote UI.
- Slot order.
- Layout mode.
- Mute state.
- Playback state.
- Active/selected slot, if supported.
- Random filter state, if remote randomization should respect/edit those filters.

The web display should remain the source of truth for actual media playback results because browser playback can fail due to autoplay restrictions or media errors. The backend should support command acknowledgement or failure events so mobile can show accurate feedback.

### Authorization And Safety

Remote control should respect the existing authenticated user/session model.

Expected behavior:

- Only authenticated clients can create or join remote sessions.
- Backend should verify that the mobile user is allowed to access/control the same library as the web user.
- Pairing codes should be short-lived.
- Commands should be validated server-side.
- Backend should prevent commands from being sent to sessions the user has not joined.
- Backend should rate-limit pairing attempts to avoid brute-forcing short codes.

### Errors And Disconnects

Backend should send clear events for:

- Invalid pairing code.
- Expired pairing code.
- Display disconnected.
- Remote disconnected.
- Session closed.
- Command rejected.
- Command failed.
- Unauthorized access.
- Version/protocol mismatch, if protocol versioning is added.

## Suggested Event Categories

Exact names are up to backend, but we need a stable typed protocol for:

- `session.created`
- `session.joined`
- `session.state`
- `session.closed`
- `client.connected`
- `client.disconnected`
- `command.sent`
- `command.ack`
- `command.rejected`
- `command.failed`
- `playback.state`

## Frontend Expectations

Once backend support exists:

- Web will create a remote session and display the pairing code.
- Web will keep a WebSocket connection open as the display client.
- Web will execute incoming commands against the existing multiplayer UI state.
- Web will report state updates and command results.
- Mobile will add a remote-control screen where users enter the code.
- Mobile will use the WebSocket protocol to send commands and subscribe to state.
- Shared DTOs/schemas should live in the shared packages so web and mobile use the same contract.

## Acceptance Criteria

Backend work is ready for frontend integration when:

- Web can create a remote session and receive a code.
- Mobile can join by code.
- Both clients can connect to the same WebSocket-backed session.
- Mobile can send validated commands to the web display.
- Web can acknowledge commands and publish updated session state.
- Mobile can recover current state after reconnecting.
- Pairing codes expire and invalid join attempts are rejected.
- Auth and permission checks are enforced.
