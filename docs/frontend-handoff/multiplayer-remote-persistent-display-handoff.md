# Multiplayer Remote Persistent Display Handoff

## Purpose

This change adds support for display devices that can be marked as pairable indefinitely, with a friendly name, without depending on the normal browser auth session lifetime.

The main goal is a smoother "Spotify Connect"-style flow:

- A display can be authorized once by the user.
- The display receives long-lived device credentials.
- The display can reconnect later using those device credentials.
- While online, the display advertises availability through websocket heartbeats.
- Trusted remote devices can discover currently available displays and show their names.

## What Changed

### New backend concept: persistent display device

There is now a dedicated backend record for trusted display devices.

Stored fields include:

- `publicId`
- `authTokenHash`
- `deviceName`
- `deviceType`
- `lastSeenAt`
- `lastHeartbeatAt`
- `revokedAt`

These display devices are separate from the existing trusted remote devices.

### New endpoint

`POST /api/multiplayer-remote/display-devices`

This is used by an authenticated client to register a persistent display device and receive its device credentials.

Request:

```json
{
  "deviceName": "Living Room TV",
  "deviceType": "desktop"
}
```

Response:

```json
{
  "success": true,
  "data": {
    "displayDevice": {
      "id": 1,
      "ownerUserId": 1,
      "publicId": "0f8fad5b-d9cb-469f-a165-70867728950e",
      "deviceName": "Living Room TV",
      "deviceType": "desktop",
      "trustedAt": "2026-05-28T12:00:00.000Z",
      "lastSeenAt": "2026-05-28T12:00:00.000Z",
      "lastHeartbeatAt": null,
      "revokedAt": null,
      "createdAt": "2026-05-28T12:00:00.000Z",
      "updatedAt": "2026-05-28T12:00:00.000Z"
    },
    "deviceSecret": "long-lived-secret-string"
  }
}
```

## Frontend responsibilities

### 1. Register the display once

When the user explicitly chooses to make a display permanently pairable:

1. Call `POST /api/multiplayer-remote/display-devices`
2. Let the user provide a friendly name
3. Store `displayDevice.publicId` and `deviceSecret` securely on that display

Important:

- `deviceSecret` is only returned at registration time.
- The frontend should treat it like a long-lived credential.

### 2. Reconnect the display using device credentials

The display websocket handshake now supports device-based auth.

Websocket path:

`GET /api/multiplayer-remote/ws`

First message:

```json
{
  "event": "client.hello",
  "payload": {
    "role": "display",
    "protocolVersion": 1,
    "clientInfo": {
      "clientId": "living-room-tv-client",
      "deviceName": "Living Room TV",
      "deviceType": "desktop"
    },
    "displayDeviceAuth": {
      "deviceId": "0f8fad5b-d9cb-469f-a165-70867728950e",
      "deviceSecret": "long-lived-secret-string"
    }
  },
  "timestamp": "2026-05-28T12:00:05.000Z",
  "protocolVersion": 1
}
```

Notes:

- `sessionId` is no longer required for display clients when using `displayDeviceAuth`.
- Existing authenticated websocket flow still works for normal session-based display usage.
- Remote clients still require the authenticated-user flow and still send `sessionId`.

### 3. Expect the backend to create or reuse the waiting session

For persistent display devices, the backend now:

- authenticates the display device
- creates a waiting session if none exists
- or reuses the latest waiting session for that display device

The `client.connected` event sent back to the display contains the resolved session object. The frontend should use the returned `session.id` from that response as the active session identifier.

### 4. Use discovery results to show named available displays

Trusted remote device discovery now includes `displayDevice` metadata on each discovered session.

`POST /api/multiplayer-remote/trusted-devices/discover`

Each session item may now contain:

```json
{
  "displayDevice": {
    "id": 1,
    "ownerUserId": 1,
    "publicId": "0f8fad5b-d9cb-469f-a165-70867728950e",
    "deviceName": "Living Room TV",
    "deviceType": "desktop",
    "trustedAt": "2026-05-28T12:00:00.000Z",
    "lastSeenAt": "2026-05-28T12:01:10.000Z",
    "lastHeartbeatAt": "2026-05-28T12:01:10.000Z",
    "revokedAt": null,
    "createdAt": "2026-05-28T12:00:00.000Z",
    "updatedAt": "2026-05-28T12:01:10.000Z"
  }
}
```

Frontend should use this to show a clearer list such as:

- Living Room TV
- Office Browser
- Bedroom Display

If `displayDevice` is `null`, fallback to current generic session labeling.

## Availability semantics

Display availability is now tied to live websocket presence and persisted heartbeats, not just the browser session token lifetime.

Current backend behavior:

- the display websocket emits a heartbeat every 10 seconds
- each heartbeat updates session `displayLastSeenAt`
- if the session belongs to a persistent display device, the heartbeat also updates `displayDevice.lastHeartbeatAt`

Frontend implication:

- a display should be considered available when it appears in trusted discovery results
- frontend does not need to infer availability from local timers if discovery already returns the display
- `lastHeartbeatAt` can be used for UI hints like "online now" or "seen a few seconds ago"

## Schema changes relevant to frontend

### `client.hello.payload`

Now supports:

```ts
type ClientHelloPayload = {
  sessionId?: number;
  role: "display" | "remote";
  protocolVersion: 1;
  clientInfo?: {
    clientId?: string;
    deviceName?: string;
    deviceType?: "mobile" | "tablet" | "desktop" | "unknown";
    userAgent?: string;
  };
  displayDeviceAuth?: {
    deviceId: string;
    deviceSecret: string;
  };
};
```

### Trusted discovery session summary

Trusted discovery sessions now include:

```ts
type DisplayDeviceSummary = {
  id: number;
  ownerUserId: number;
  publicId: string;
  deviceName: string;
  deviceType: "mobile" | "tablet" | "desktop" | "unknown" | null;
  trustedAt: string;
  lastSeenAt: string | null;
  lastHeartbeatAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
};
```

Added field on discovered session:

```ts
displayDevice: DisplayDeviceSummary | null;
```

## Recommended frontend changes

### Display app / web player

- Add a UI action like "Keep this display available"
- Prompt for a display name
- Register the display device once
- Persist `deviceId` and `deviceSecret`
- On app load, prefer device-auth websocket connect if persistent display mode is enabled
- After `client.connected`, read the returned `session.id` and use it as the current session

### Remote app

- In trusted-device discovery UI, show `displayDevice.deviceName` when present
- Optionally show `displayDevice.lastHeartbeatAt` as presence info
- Keep current fallback behavior for sessions without display-device metadata

## Backward compatibility

- Existing pairing code flow still works.
- Existing trusted remote device flow still works.
- Existing authenticated display websocket flow still works.

This change only adds a second display-auth path for long-lived pairable displays.

## Open follow-up items

These are not part of the current backend change, but frontend should be aware of them:

- There is not yet a revoke/delete display-device endpoint.
- There is not yet a list display-devices endpoint for settings management.
- If frontend wants device management UI, backend will need follow-up endpoints.
