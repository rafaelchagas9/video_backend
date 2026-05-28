export const multiplayerRemoteProtocolVersion = 1;

export const multiplayerRemoteClientRoleValues = ["display", "remote"] as const;

export const multiplayerRemoteSessionStatusValues = [
  "waiting_for_remote",
  "pending_approval",
  "active",
  "closed",
  "expired",
] as const;

export const multiplayerRemoteJoinRequestStatusValues = [
  "pending",
  "approved",
  "rejected",
  "expired",
  "cancelled",
] as const;

export const multiplayerRemoteDeviceTypeValues = [
  "mobile",
  "tablet",
  "desktop",
  "unknown",
] as const;

export const multiplayerRemoteCommandTypeValues = [
  "slots.add_videos",
  "slots.remove",
  "slots.clear",
  "slots.reorder",
  "slots.randomize_all",
  "slots.randomize_one",
  "playback.play_all",
  "playback.pause_all",
  "playback.play_slot",
  "playback.pause_slot",
  "playback.set_timestamp",
  "audio.mute_all",
  "audio.unmute_all",
  "audio.mute_slot",
  "audio.unmute_slot",
  "layout.set_mode",
  "layout.set_slot_size",
  "layout.reset_slot_size",
  "selection.set_active_slot",
  "filters.update",
  "filters.reset",
] as const;

export const multiplayerRemoteEventNameValues = [
  "client.hello",
  "client.connected",
  "client.disconnected",
  "session.created",
  "session.state",
  "session.join_requested",
  "session.join_approved",
  "session.join_rejected",
  "session.closed",
  "command.request",
  "command.ack",
  "command.rejected",
  "command.failed",
  "playback.state",
] as const;

export type MultiplayerRemoteClientRole =
  (typeof multiplayerRemoteClientRoleValues)[number];
export type MultiplayerRemoteSessionStatus =
  (typeof multiplayerRemoteSessionStatusValues)[number];
export type MultiplayerRemoteJoinRequestStatus =
  (typeof multiplayerRemoteJoinRequestStatusValues)[number];
export type MultiplayerRemoteDeviceType =
  (typeof multiplayerRemoteDeviceTypeValues)[number];
export type MultiplayerRemoteCommandType =
  (typeof multiplayerRemoteCommandTypeValues)[number];
export type MultiplayerRemoteEventName =
  (typeof multiplayerRemoteEventNameValues)[number];

export interface MultiplayerRemoteClientInfo {
  clientId?: string;
  deviceName?: string;
  deviceType?: MultiplayerRemoteDeviceType;
  userAgent?: string;
}

export interface MultiplayerRemoteSlotSnapshot {
  slotId: string;
  videoId: number | null;
  title: string | null;
  thumbnailUrl: string | null;
  muted: boolean;
  playing: boolean;
  size: number | null;
  currentTimestampSeconds?: number | null;
  durationSeconds?: number | null;
}

export interface MultiplayerRemoteSessionSnapshot {
  sessionId: number;
  status: MultiplayerRemoteSessionStatus;
  layoutMode: string;
  slots: MultiplayerRemoteSlotSnapshot[];
  slotOrder: string[];
  activeSlotId: string | null;
  filters: Record<string, unknown>;
  updatedAt: string;
}

export interface MultiplayerRemoteEventEnvelope<TPayload = unknown> {
  event: MultiplayerRemoteEventName;
  payload: TPayload;
  timestamp: string;
  protocolVersion: typeof multiplayerRemoteProtocolVersion;
  sessionId?: number;
  commandId?: string;
}

export interface MultiplayerRemoteCommandRequest {
  type: MultiplayerRemoteCommandType;
  args: Record<string, unknown>;
}
