# Multiplayer Remote Frontend Handoff

## Idea

Multiplayer remote control links two authenticated clients owned by the same user:

- Display: the web multiplayer page. It owns real playback, browser media state, and final UI state.
- Remote: the mobile client. It pairs by code, sends commands, and renders the latest display-reported state.

The backend coordinates the session lifecycle, pairing approval, validation, persistence, and websocket routing. The backend does not calculate playback truth. The display executes commands and then publishes the resulting `session.state`.

## Important Rules

- Base HTTP path: `/api/multiplayer-remote`
- Websocket path: `/api/multiplayer-remote/ws`
- Protocol version: `1`
- Auth: use existing browser/mobile session cookies. All endpoints and the websocket require authentication.
- User constraint: remote and display must be authenticated as the same user.
- Only one display and one active remote websocket are allowed per session.
- Pairing code format: 6 uppercase alphanumeric characters.
- Pairing code TTL: 5 minutes.
- Pending approval TTL: 2 minutes.
- Pairing requires manual approval by the display.
- The remote websocket cannot connect until the join request is approved.
- If the display websocket disconnects, the backend closes the session.
- If the remote websocket disconnects, the session remains approved and the remote can reconnect while the display stays connected.

## HTTP Flow

### 1. Display Creates Session

`POST /api/multiplayer-remote/sessions`

Request body: none.

Response:

```json
{
  "success": true,
  "data": {
    "id": 123,
    "ownerUserId": 1,
    "displayClientId": null,
    "remoteClientId": null,
    "pairingCode": "A7B2Q9",
    "pairingCodeExpiresAt": "2026-05-26T15:10:00.000Z",
    "status": "waiting_for_remote",
    "displayConnectedAt": null,
    "displayLastSeenAt": null,
    "remoteConnectedAt": null,
    "remoteLastSeenAt": null,
    "approvedAt": null,
    "closedAt": null,
    "closeReason": null,
    "lastState": null,
    "protocolVersion": 1,
    "createdAt": "2026-05-26T15:05:00.000Z",
    "updatedAt": "2026-05-26T15:05:00.000Z",
    "pendingJoinRequest": null
  }
}
```

Display should immediately open the websocket as role `display`; pairing is rejected until the display is connected.

### 2. Display Connects Websocket

Open `GET /api/multiplayer-remote/ws`, then send `client.hello` as the first websocket message.

```json
{
  "event": "client.hello",
  "payload": {
    "sessionId": 123,
    "role": "display",
    "protocolVersion": 1,
    "clientInfo": {
      "clientId": "web-display-uuid",
      "deviceName": "Living Room Browser",
      "deviceType": "desktop"
    }
  },
  "timestamp": "2026-05-26T15:05:01.000Z",
  "protocolVersion": 1,
  "sessionId": 123
}
```

The backend responds with `client.connected`.

### 3. Remote Submits Pairing Code

`POST /api/multiplayer-remote/pair`

This route is rate-limited to 10 requests per minute.

```json
{
  "pairingCode": "A7B2Q9",
  "remoteDeviceName": "Rafael's Phone",
  "remoteDeviceType": "mobile"
}
```

Response:

```json
{
  "success": true,
  "data": {
    "sessionId": 123,
    "joinRequest": {
      "id": 456,
      "sessionId": 123,
      "requestingUserId": 1,
      "requestingSessionId": "auth-session-id",
      "status": "pending",
      "requestedCode": "A7B2Q9",
      "remoteDeviceName": "Rafael's Phone",
      "remoteDeviceType": "mobile",
      "remoteUserAgent": "Mobile UA",
      "expiresAt": "2026-05-26T15:07:01.000Z",
      "resolvedAt": null,
      "createdAt": "2026-05-26T15:05:01.000Z",
      "updatedAt": "2026-05-26T15:05:01.000Z"
    }
  }
}
```

This causes the display websocket to receive `session.join_requested`.

### 4. Display Approves Or Rejects

Display can show the request from `session.join_requested` or fetch it:

`GET /api/multiplayer-remote/sessions/:id/join-requests/pending`

Approve:

`POST /api/multiplayer-remote/sessions/:id/join-requests/:requestId/approve`

Reject:

`POST /api/multiplayer-remote/sessions/:id/join-requests/:requestId/reject`

Approval invalidates the pairing code and moves the session to `active`.

### 5. Remote Waits, Then Connects Websocket

The remote websocket is rejected until approval is complete. Recommended mobile behavior:

1. Submit `/pair`.
2. Poll `GET /api/multiplayer-remote/sessions/:sessionId` every 1-2 seconds while waiting.
3. If `status === "active"`, open the websocket as role `remote`.
4. If `status === "waiting_for_remote"` and `pendingJoinRequest` is null after a submitted request, treat it as rejected or expired and show a retry state.
5. If `status === "closed"` or `status === "expired"`, stop and show an error.

Remote `client.hello`:

```json
{
  "event": "client.hello",
  "payload": {
    "sessionId": 123,
    "role": "remote",
    "protocolVersion": 1,
    "clientInfo": {
      "clientId": "mobile-remote-uuid",
      "deviceName": "Rafael's Phone",
      "deviceType": "mobile"
    }
  },
  "timestamp": "2026-05-26T15:05:20.000Z",
  "protocolVersion": 1,
  "sessionId": 123
}
```

If the display has already published state, the remote receives `session.state` immediately after `client.connected`.

### 6. Display Closes Session

`POST /api/multiplayer-remote/sessions/:id/close`

```json
{
  "reason": "closed_by_user"
}
```

Connected clients receive `session.closed`, then the backend closes active multiplayer sockets.

## Websocket Envelope

Every websocket message uses this envelope:

```ts
type MultiplayerRemoteEventEnvelope<TPayload = unknown> = {
  event: string;
  payload: TPayload;
  timestamp: string; // ISO datetime
  protocolVersion: 1;
  sessionId?: number;
  commandId?: string;
};
```

`protocolVersion` is required at the top level. `client.hello.payload.protocolVersion` is also required and must be `1`.

Unsupported protocol versions are rejected with `command.rejected` or close the initial handshake.

## Session Snapshot

The display must publish `session.state` after websocket connect and after every successful mutation.

```ts
type SessionSnapshot = {
  sessionId: number;
  status: "waiting_for_remote" | "pending_approval" | "active" | "closed" | "expired";
  layoutMode: string;
  slots: Array<{
    slotId: string;
    videoId: number | null;
    title: string | null;
    thumbnailUrl: string | null; // must be a valid URL when present
    muted: boolean;
    volume: number; // normalized 0..1
    playing: boolean;
    size: number | null;
  }>;
  slotOrder: string[];
  activeSlotId: string | null;
  filters: Record<string, unknown>;
  updatedAt: string; // ISO datetime
};
```

Display sends:

```json
{
  "event": "session.state",
  "payload": {
    "sessionId": 123,
    "status": "active",
    "layoutMode": "2x2",
    "slots": [
      {
        "slotId": "slot-1",
        "videoId": 42,
        "title": "Example Video",
        "thumbnailUrl": "http://localhost:3000/api/videos/42/thumbnail",
        "muted": false,
        "volume": 0.8,
        "playing": true,
        "size": null
      }
    ],
    "slotOrder": ["slot-1"],
    "activeSlotId": "slot-1",
    "filters": {
      "tags": [1, 2],
      "ratingMin": 4
    },
    "updatedAt": "2026-05-26T15:05:30.000Z"
  },
  "timestamp": "2026-05-26T15:05:30.000Z",
  "protocolVersion": 1,
  "sessionId": 123
}
```

Backend persists this snapshot as `lastState` and broadcasts it to the active remote.

## Websocket Events

### `client.hello`

Direction: client -> backend.

First websocket message only. Binds the socket to a session and role.

Payload:

```ts
{
  sessionId: number;
  role: "display" | "remote";
  protocolVersion: 1;
  clientInfo?: {
    clientId?: string;
    deviceName?: string;
    deviceType?: "mobile" | "tablet" | "desktop" | "unknown";
    userAgent?: string;
  };
}
```

### `client.connected`

Direction: backend -> client.

Sent after a successful `client.hello`. Also sent periodically as a heartbeat with `{ "heartbeat": true }`.

Initial payload:

```ts
{
  role: "display" | "remote";
  clientId: string;
  session: MultiplayerRemoteSession;
}
```

Heartbeat payload:

```ts
{
  heartbeat: true;
}
```

### `session.join_requested`

Direction: backend -> display.

Sent when the remote submits a valid pairing code and approval is required.

Payload:

```ts
{
  joinRequest: JoinRequest;
}
```

Display should show the requester metadata and call approve or reject.

### `session.join_approved`

Direction: backend -> connected clients.

Sent after the display approves a pending join request.

Payload:

```ts
{
  session: MultiplayerRemoteSession;
}
```

### `session.join_rejected`

Direction: backend -> connected clients.

Sent after the display rejects a pending join request.

Payload:

```ts
{
  session: MultiplayerRemoteSession;
}
```

Practical note: because remote websocket binding is blocked before approval, mobile usually will not receive this event directly. Use HTTP polling while waiting for approval.

### `session.state`

Direction: display -> backend -> remote.

Display publishes the latest state. Backend validates, persists, and forwards it.

Payload: `SessionSnapshot`.

### `session.closed`

Direction: backend -> clients.

Sent when the session is explicitly closed or the display disconnects.

Payload:

```ts
{
  reason: string;
}
```

### `command.request`

Direction: remote -> backend -> display.

Remote asks the display to perform an action. The display is responsible for applying it to local UI/playback state.

Envelope requires `commandId`.

```json
{
  "event": "command.request",
  "payload": {
    "type": "playback.pause_all",
    "args": {}
  },
  "timestamp": "2026-05-26T15:06:00.000Z",
  "protocolVersion": 1,
  "sessionId": 123,
  "commandId": "cmd-001"
}
```

Display should respond with `command.ack` if accepted or `command.failed` if execution failed. After successful mutations, display should also send `session.state`.

### `command.ack`

Direction: display -> backend -> remote.

```json
{
  "event": "command.ack",
  "payload": {
    "accepted": true
  },
  "timestamp": "2026-05-26T15:06:01.000Z",
  "protocolVersion": 1,
  "sessionId": 123,
  "commandId": "cmd-001"
}
```

### `command.failed`

Direction: display -> backend -> remote.

Use this when the display received a valid command but could not execute it.

```json
{
  "event": "command.failed",
  "payload": {
    "message": "Slot no longer exists"
  },
  "timestamp": "2026-05-26T15:06:01.000Z",
  "protocolVersion": 1,
  "sessionId": 123,
  "commandId": "cmd-001"
}
```

### `command.rejected`

Direction: backend -> sender.

Use this for invalid roles, invalid session state, validation errors, disconnected display, unsupported event, or protocol mismatch.

Payload:

```ts
{
  message: string;
}
```

If rejection relates to a command, `commandId` may be included in the envelope.

## Supported Commands

All commands use:

```ts
type CommandRequest = {
  type: CommandType;
  args: object;
};
```

Supported command types and args:

```ts
type Command =
  | { type: "slots.add_videos"; args: { videoIds: number[]; targetSlotId?: string } }
  | { type: "slots.remove"; args: { slotId: string } }
  | { type: "slots.clear"; args: {} }
  | { type: "slots.reorder"; args: { slotOrder: string[] } }
  | { type: "slots.randomize_all"; args: { filters?: Record<string, unknown> } }
  | { type: "slots.randomize_one"; args: { slotId: string; filters?: Record<string, unknown> } }
  | { type: "playback.play_all"; args: {} }
  | { type: "playback.pause_all"; args: {} }
  | { type: "playback.play_slot"; args: { slotId: string } }
  | { type: "playback.pause_slot"; args: { slotId: string } }
  | { type: "audio.mute_all"; args: {} }
  | { type: "audio.unmute_all"; args: {} }
  | { type: "audio.mute_slot"; args: { slotId: string } }
  | { type: "audio.unmute_slot"; args: { slotId: string } }
  | { type: "audio.set_all_volume"; args: { volume: number } }
  | { type: "audio.set_slot_volume"; args: { slotId: string; volume: number } }
  | { type: "layout.set_mode"; args: { mode: string } }
  | { type: "layout.set_slot_size"; args: { slotId: string; size: number } }
  | { type: "layout.reset_slot_size"; args: { slotId?: string } }
  | { type: "selection.set_active_slot"; args: { slotId: string } }
  | { type: "filters.update"; args: { filters: Record<string, unknown> } }
  | { type: "filters.reset"; args: {} };
```

Validation notes:

- `videoIds` must contain at least one positive integer.
- `slotId`, `targetSlotId`, and layout `mode` are non-empty strings.
- `size` must be positive.
- `volume` must be a finite number between `0` and `1`.
- `filters` may contain arbitrary JSON-compatible values.

## HTTP Session Object

```ts
type MultiplayerRemoteSession = {
  id: number;
  ownerUserId: number;
  displayClientId: string | null;
  remoteClientId: string | null;
  pairingCode: string | null;
  pairingCodeExpiresAt: string | null;
  status: "waiting_for_remote" | "pending_approval" | "active" | "closed" | "expired";
  displayConnectedAt: string | null;
  displayLastSeenAt: string | null;
  remoteConnectedAt: string | null;
  remoteLastSeenAt: string | null;
  approvedAt: string | null;
  closedAt: string | null;
  closeReason: string | null;
  lastState: SessionSnapshot | null;
  protocolVersion: number;
  createdAt: string;
  updatedAt: string;
  pendingJoinRequest?: JoinRequest | null;
};

type JoinRequest = {
  id: number;
  sessionId: number;
  requestingUserId: number;
  requestingSessionId: string | null;
  status: "pending" | "approved" | "rejected" | "expired" | "cancelled";
  requestedCode: string;
  remoteDeviceName: string | null;
  remoteDeviceType: "mobile" | "tablet" | "desktop" | "unknown" | null;
  remoteUserAgent: string | null;
  expiresAt: string;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
};
```

## Error Handling

HTTP error shape:

```json
{
  "success": false,
  "error": {
    "message": "Pairing code has expired",
    "statusCode": 400
  }
}
```

Common frontend cases:

- `401`: user is not authenticated.
- `403`: pairing attempted by a different user, or websocket role is not allowed.
- `404`: session, join request, or pairing code not found.
- `409`: session is closed, display is not connected, or a remote is already active.
- `429`: too many pairing attempts.

## Display Implementation Checklist

- Create session on multiplayer page load or when the user enables remote control.
- Show `pairingCode` and expiry countdown.
- Open websocket as `display` immediately after session creation.
- Publish initial `session.state` after `client.connected`.
- Listen for `session.join_requested` and show approve/reject UI.
- Execute incoming `command.request` events against the existing multiplayer state.
- Send `command.ack` or `command.failed` for every command.
- Send fresh `session.state` after every successful mutation.
- Close the session on page unload or when user disables remote control.
- Treat `session.closed` as terminal and tear down the remote UI.

## Mobile Implementation Checklist

- Provide pairing-code entry UI.
- Call `POST /pair` with device metadata.
- Poll `GET /sessions/:id` while waiting for approval.
- Connect websocket as `remote` after session status becomes `active`.
- Render `lastState` from HTTP or the first `session.state` websocket event.
- Send `command.request` with unique `commandId` values.
- Track command pending state until `command.ack`, `command.failed`, or `command.rejected`.
- Update UI from `session.state`, not from optimistic command assumptions.
- On websocket disconnect, reconnect with the same `clientId` if the session is still active.
- On `session.closed`, stop reconnecting and return to pairing/start state.
