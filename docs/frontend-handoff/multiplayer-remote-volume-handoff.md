# Multiplayer Remote Volume Handoff

## Scope

This handoff covers the backend protocol changes added for per-video volume control in multiplayer remote.

The backend now supports:

- Per-slot persisted volume in `session.state`
- A remote command to set volume for one slot
- A remote command to set volume for all slots

The backend still does not execute playback changes itself. The display client remains the source of truth for local media state and must publish updated `session.state` after applying commands.

## Backend Changes

The multiplayer remote protocol now includes these command types:

```ts
{ type: "audio.set_all_volume"; args: { volume: number } }
{ type: "audio.set_slot_volume"; args: { slotId: string; volume: number } }
```

The session snapshot slot shape now includes:

```ts
type SlotSnapshot = {
  slotId: string;
  videoId: number | null;
  title: string | null;
  thumbnailUrl: string | null;
  muted: boolean;
  volume: number;
  playing: boolean;
  size: number | null;
  currentTimestampSeconds?: number | null;
  durationSeconds?: number | null;
};
```

Validation enforced by backend:

- `volume` must be a finite number
- `volume` must be between `0` and `1`
- `slotId` must be a non-empty string for `audio.set_slot_volume`

## Frontend Work Required

### Display Client

The display client needs to:

- Extend its local multiplayer slot state with `volume`
- Include `volume` for every slot in every `session.state` message
- Handle `audio.set_all_volume`
- Handle `audio.set_slot_volume`
- Apply volume changes to the actual media elements
- Send `command.ack` or `command.failed`
- Publish a fresh `session.state` after successful volume changes

Recommended behavior:

- Treat `volume` as normalized `0..1`
- Keep `muted` and `volume` separate
- Do not infer mute from `volume === 0` unless that is already intentional in the player UX
- Preserve existing mute commands and make them work independently from volume level storage

Suggested display command handling:

```ts
switch (command.type) {
  case "audio.set_all_volume":
    for (const slot of slots) {
      slot.volume = command.args.volume;
      applyMediaElementVolume(slot.slotId, command.args.volume);
    }
    publishSessionState();
    ack(commandId);
    break;

  case "audio.set_slot_volume":
    updateSlot(command.args.slotId, {
      volume: command.args.volume,
    });
    applyMediaElementVolume(command.args.slotId, command.args.volume);
    publishSessionState();
    ack(commandId);
    break;
}
```

If the requested slot does not exist, return `command.failed`.

### Remote Client

The remote client needs to:

- Read `slot.volume` from `lastState` or websocket `session.state`
- Render per-slot volume controls
- Optionally render a global volume control
- Send `audio.set_slot_volume` when a single slot changes
- Send `audio.set_all_volume` when the global control changes
- Update UI from authoritative `session.state`, not only optimistic local state

Suggested remote payloads:

```json
{
  "event": "command.request",
  "payload": {
    "type": "audio.set_slot_volume",
    "args": {
      "slotId": "slot-2",
      "volume": 0.35
    }
  },
  "timestamp": "2026-05-28T12:00:00.000Z",
  "protocolVersion": 1,
  "sessionId": 123,
  "commandId": "cmd-volume-slot-1"
}
```

```json
{
  "event": "command.request",
  "payload": {
    "type": "audio.set_all_volume",
    "args": {
      "volume": 0.6
    }
  },
  "timestamp": "2026-05-28T12:00:00.000Z",
  "protocolVersion": 1,
  "sessionId": 123,
  "commandId": "cmd-volume-all-1"
}
```

## State Contract Notes

Frontend should now assume:

- Every slot snapshot includes `volume`
- The backend validates and persists that field in `lastState`
- The remote may receive a prior snapshot that was created before this feature existed

For compatibility, the frontend should tolerate missing `volume` during rollout and default it safely, for example:

```ts
const normalizedVolume =
  typeof slot.volume === "number" && Number.isFinite(slot.volume)
    ? Math.max(0, Math.min(1, slot.volume))
    : 1;
```

## Rollout Checklist

- Update shared frontend types for multiplayer slot snapshots
- Update shared frontend command union
- Add UI controls for per-slot volume
- Add optional UI control for all-slot volume
- Ensure display publishes `volume` in every snapshot
- Ensure reconnect state hydration reads `volume` from `lastState`
- Verify mute commands still behave correctly alongside volume changes

## Acceptance Criteria

Frontend integration is complete when:

- Remote can change one slot volume
- Remote can change all slot volumes
- Display applies the change to actual media elements
- Updated `session.state` includes the new `volume` values
- Remote UI stays in sync after reconnect or page refresh
- Existing mute and unmute controls still work
