import { z } from "zod";
import {
  multiplayerRemoteClientRoleValues,
  multiplayerRemoteCommandTypeValues,
  multiplayerRemoteDeviceTypeValues,
  multiplayerRemoteEventNameValues,
  multiplayerRemoteJoinRequestStatusValues,
  multiplayerRemoteProtocolVersion,
  multiplayerRemoteSessionStatusValues,
} from "./multiplayer-remote.types";

export const sessionIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export const joinRequestIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
  requestId: z.coerce.number().int().positive(),
});

export const closeSessionBodySchema = z.object({
  reason: z.string().trim().min(1).max(200).optional(),
});

export const pairBodySchema = z.object({
  pairingCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{6}$/),
  remoteDeviceKey: z.string().trim().min(32).max(256).optional(),
  remoteDeviceName: z.string().trim().min(1).max(120).optional(),
  remoteDeviceType: z.enum(multiplayerRemoteDeviceTypeValues).optional(),
});

export const trustedDeviceBodySchema = z.object({
  remoteDeviceKey: z.string().trim().min(32).max(256),
  remoteDeviceName: z.string().trim().min(1).max(120).optional(),
  remoteDeviceType: z.enum(multiplayerRemoteDeviceTypeValues).optional(),
});

export const clientInfoSchema = z.object({
  clientId: z.string().trim().min(1).max(120).optional(),
  deviceName: z.string().trim().min(1).max(120).optional(),
  deviceType: z.enum(multiplayerRemoteDeviceTypeValues).optional(),
  userAgent: z.string().trim().min(1).max(500).optional(),
});

export const clientHelloPayloadSchema = z.object({
  sessionId: z.number().int().positive(),
  role: z.enum(multiplayerRemoteClientRoleValues),
  protocolVersion: z.literal(multiplayerRemoteProtocolVersion),
  clientInfo: clientInfoSchema.optional(),
});

const slotSnapshotSchema = z.object({
  slotId: z.string().trim().min(1).max(120),
  videoId: z.number().int().positive().nullable(),
  title: z.string().nullable(),
  thumbnailUrl: z.url().nullable(),
  muted: z.boolean(),
  playing: z.boolean(),
  size: z.number().finite().positive().nullable(),
  currentTimestampSeconds: z.number().finite().min(0).nullable().optional(),
  durationSeconds: z.number().finite().min(0).nullable().optional(),
});

export const sessionSnapshotSchema = z.object({
  sessionId: z.number().int().positive(),
  status: z.enum(multiplayerRemoteSessionStatusValues),
  layoutMode: z.string().trim().min(1).max(80),
  slots: z.array(slotSnapshotSchema),
  slotOrder: z.array(z.string().trim().min(1).max(120)),
  activeSlotId: z.string().trim().min(1).max(120).nullable(),
  filters: z.record(z.string(), z.unknown()),
  updatedAt: z.iso.datetime(),
});

const slotIdPayloadSchema = z.object({
  slotId: z.string().trim().min(1).max(120),
});

const timestampPayloadSchema = slotIdPayloadSchema.extend({
  timestampSeconds: z.number().finite().min(0),
});

const playbackStatePayloadSchema = slotIdPayloadSchema.extend({
  videoId: z.number().int().positive().nullable().optional(),
  currentTimestampSeconds: z.number().finite().min(0),
  durationSeconds: z.number().finite().min(0).nullable().optional(),
  playing: z.boolean().optional(),
  updatedAt: z.iso.datetime().optional(),
});

const slotSizePayloadSchema = slotIdPayloadSchema.extend({
  size: z.number().finite().positive(),
});

const videoIdsPayloadSchema = z.object({
  videoIds: z.array(z.number().int().positive()).min(1),
  targetSlotId: z.string().trim().min(1).max(120).optional(),
});

const reorderSlotsPayloadSchema = z.object({
  slotOrder: z.array(z.string().trim().min(1).max(120)).min(1),
});

const layoutModePayloadSchema = z.object({
  mode: z.string().trim().min(1).max(80),
});

const filtersPayloadSchema = z.object({
  filters: z.record(z.string(), z.unknown()),
});

const commandPayloadSchemas = {
  "slots.add_videos": videoIdsPayloadSchema,
  "slots.remove": slotIdPayloadSchema,
  "slots.clear": z.object({}),
  "slots.reorder": reorderSlotsPayloadSchema,
  "slots.randomize_all": filtersPayloadSchema.partial().default({}),
  "slots.randomize_one": slotIdPayloadSchema.merge(filtersPayloadSchema.partial()),
  "playback.play_all": z.object({}),
  "playback.pause_all": z.object({}),
  "playback.play_slot": slotIdPayloadSchema,
  "playback.pause_slot": slotIdPayloadSchema,
  "playback.set_timestamp": timestampPayloadSchema,
  "audio.mute_all": z.object({}),
  "audio.unmute_all": z.object({}),
  "audio.mute_slot": slotIdPayloadSchema,
  "audio.unmute_slot": slotIdPayloadSchema,
  "layout.set_mode": layoutModePayloadSchema,
  "layout.set_slot_size": slotSizePayloadSchema,
  "layout.reset_slot_size": slotIdPayloadSchema.partial().default({}),
  "selection.set_active_slot": slotIdPayloadSchema,
  "filters.update": filtersPayloadSchema,
  "filters.reset": z.object({}),
} satisfies Record<
  (typeof multiplayerRemoteCommandTypeValues)[number],
  z.ZodType
>;

export const commandRequestPayloadSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("slots.add_videos"),
    args: commandPayloadSchemas["slots.add_videos"],
  }),
  z.object({
    type: z.literal("slots.remove"),
    args: commandPayloadSchemas["slots.remove"],
  }),
  z.object({
    type: z.literal("slots.clear"),
    args: commandPayloadSchemas["slots.clear"],
  }),
  z.object({
    type: z.literal("slots.reorder"),
    args: commandPayloadSchemas["slots.reorder"],
  }),
  z.object({
    type: z.literal("slots.randomize_all"),
    args: commandPayloadSchemas["slots.randomize_all"],
  }),
  z.object({
    type: z.literal("slots.randomize_one"),
    args: commandPayloadSchemas["slots.randomize_one"],
  }),
  z.object({
    type: z.literal("playback.play_all"),
    args: commandPayloadSchemas["playback.play_all"],
  }),
  z.object({
    type: z.literal("playback.pause_all"),
    args: commandPayloadSchemas["playback.pause_all"],
  }),
  z.object({
    type: z.literal("playback.play_slot"),
    args: commandPayloadSchemas["playback.play_slot"],
  }),
  z.object({
    type: z.literal("playback.pause_slot"),
    args: commandPayloadSchemas["playback.pause_slot"],
  }),
  z.object({
    type: z.literal("playback.set_timestamp"),
    args: commandPayloadSchemas["playback.set_timestamp"],
  }),
  z.object({
    type: z.literal("audio.mute_all"),
    args: commandPayloadSchemas["audio.mute_all"],
  }),
  z.object({
    type: z.literal("audio.unmute_all"),
    args: commandPayloadSchemas["audio.unmute_all"],
  }),
  z.object({
    type: z.literal("audio.mute_slot"),
    args: commandPayloadSchemas["audio.mute_slot"],
  }),
  z.object({
    type: z.literal("audio.unmute_slot"),
    args: commandPayloadSchemas["audio.unmute_slot"],
  }),
  z.object({
    type: z.literal("layout.set_mode"),
    args: commandPayloadSchemas["layout.set_mode"],
  }),
  z.object({
    type: z.literal("layout.set_slot_size"),
    args: commandPayloadSchemas["layout.set_slot_size"],
  }),
  z.object({
    type: z.literal("layout.reset_slot_size"),
    args: commandPayloadSchemas["layout.reset_slot_size"],
  }),
  z.object({
    type: z.literal("selection.set_active_slot"),
    args: commandPayloadSchemas["selection.set_active_slot"],
  }),
  z.object({
    type: z.literal("filters.update"),
    args: commandPayloadSchemas["filters.update"],
  }),
  z.object({
    type: z.literal("filters.reset"),
    args: commandPayloadSchemas["filters.reset"],
  }),
]);

export const websocketEventEnvelopeSchema = z.object({
  event: z.enum(multiplayerRemoteEventNameValues),
  payload: z.unknown(),
  timestamp: z.iso.datetime(),
  protocolVersion: z.literal(multiplayerRemoteProtocolVersion),
  sessionId: z.number().int().positive().optional(),
  commandId: z.string().trim().min(1).max(120).optional(),
});

export const clientHelloEventSchema = websocketEventEnvelopeSchema.extend({
  event: z.literal("client.hello"),
  payload: clientHelloPayloadSchema,
});

export const sessionStateEventSchema = websocketEventEnvelopeSchema.extend({
  event: z.literal("session.state"),
  payload: sessionSnapshotSchema,
});

export const playbackStateEventSchema = websocketEventEnvelopeSchema.extend({
  event: z.literal("playback.state"),
  payload: playbackStatePayloadSchema,
});

export const commandRequestEventSchema = websocketEventEnvelopeSchema.extend({
  event: z.literal("command.request"),
  payload: commandRequestPayloadSchema,
  commandId: z.string().trim().min(1).max(120),
});

export const commandAckEventSchema = websocketEventEnvelopeSchema.extend({
  event: z.literal("command.ack"),
  commandId: z.string().trim().min(1).max(120),
  payload: z.object({
    accepted: z.boolean().default(true),
  }),
});

export const commandFailedEventSchema = websocketEventEnvelopeSchema.extend({
  event: z.literal("command.failed"),
  commandId: z.string().trim().min(1).max(120),
  payload: z.object({
    message: z.string().trim().min(1).max(500),
  }),
});

export const sessionStatusSchema = z.enum(multiplayerRemoteSessionStatusValues);
export const joinRequestStatusSchema = z.enum(
  multiplayerRemoteJoinRequestStatusValues,
);

const errorSchema = z.object({
  message: z.string(),
  statusCode: z.number(),
});

export const joinRequestSummarySchema = z.object({
  id: z.number(),
  sessionId: z.number(),
  requestingUserId: z.number(),
  requestingSessionId: z.string().nullable(),
  status: joinRequestStatusSchema,
  requestedCode: z.string(),
  canTrustDevice: z.boolean(),
  remoteDeviceName: z.string().nullable(),
  remoteDeviceType: z.enum(multiplayerRemoteDeviceTypeValues).nullable(),
  remoteUserAgent: z.string().nullable(),
  expiresAt: z.string(),
  resolvedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const multiplayerRemoteSessionSchema = z.object({
  id: z.number(),
  ownerUserId: z.number(),
  displayClientId: z.string().nullable(),
  remoteClientId: z.string().nullable(),
  pairingCode: z.string().nullable(),
  pairingCodeExpiresAt: z.string().nullable(),
  status: sessionStatusSchema,
  displayConnectedAt: z.string().nullable(),
  displayLastSeenAt: z.string().nullable(),
  remoteConnectedAt: z.string().nullable(),
  remoteLastSeenAt: z.string().nullable(),
  approvedAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  closeReason: z.string().nullable(),
  lastState: sessionSnapshotSchema.nullable(),
  protocolVersion: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  pendingJoinRequest: joinRequestSummarySchema.nullable().optional(),
});

export const createSessionResponseSchema = z.object({
  success: z.literal(true),
  data: multiplayerRemoteSessionSchema.extend({
    pairingCode: z.string(),
    pairingCodeExpiresAt: z.string(),
  }),
});

export const sessionResponseSchema = z.object({
  success: z.literal(true),
  data: multiplayerRemoteSessionSchema,
});

export const pairResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    sessionId: z.number(),
    joinRequest: joinRequestSummarySchema,
  }),
});

export const trustedDeviceSchema = z.object({
  id: z.number(),
  ownerUserId: z.number(),
  deviceName: z.string().nullable(),
  deviceType: z.enum(multiplayerRemoteDeviceTypeValues).nullable(),
  userAgent: z.string().nullable(),
  trustedAt: z.string(),
  lastSeenAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const trustedConnectResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    session: multiplayerRemoteSessionSchema,
    trustedDevice: trustedDeviceSchema,
  }),
});

export const trustedSessionSummarySchema = multiplayerRemoteSessionSchema.pick({
  id: true,
  ownerUserId: true,
  displayClientId: true,
  status: true,
  displayConnectedAt: true,
  displayLastSeenAt: true,
  lastState: true,
  protocolVersion: true,
  createdAt: true,
  updatedAt: true,
});

export const trustedDiscoveryResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    trustedDevice: trustedDeviceSchema,
    sessions: z.array(trustedSessionSummarySchema),
  }),
});

export const pendingJoinRequestResponseSchema = z.object({
  success: z.literal(true),
  data: joinRequestSummarySchema.nullable(),
});

export const messageResponseSchema = z.object({
  success: z.literal(true),
  message: z.string(),
});

export const errorResponseSchema = z.object({
  success: z.literal(false),
  error: errorSchema,
});

export type PairBody = z.infer<typeof pairBodySchema>;
export type TrustedDeviceBody = z.infer<typeof trustedDeviceBodySchema>;
export type CloseSessionBody = z.infer<typeof closeSessionBodySchema>;
export type ClientHelloPayload = z.infer<typeof clientHelloPayloadSchema>;
export type SessionSnapshot = z.infer<typeof sessionSnapshotSchema>;
export type PlaybackStatePayload = z.infer<typeof playbackStatePayloadSchema>;
export type CommandRequestPayload = z.infer<typeof commandRequestPayloadSchema>;
