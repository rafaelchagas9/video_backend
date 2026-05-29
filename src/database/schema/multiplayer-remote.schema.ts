import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  json,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sessionsTable, usersTable } from "./users.schema";

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

export const multiplayerRemoteTrustedDevicesTable = pgTable(
  "multiplayer_remote_trusted_devices",
  {
    id: serial("id").primaryKey(),
    ownerUserId: integer("owner_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    deviceKeyHash: text("device_key_hash").notNull(),
    deviceName: text("device_name"),
    deviceType: text("device_type"),
    userAgent: text("user_agent"),
    trustedAt: timestamp("trusted_at").defaultNow().notNull(),
    lastSeenAt: timestamp("last_seen_at"),
    revokedAt: timestamp("revoked_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => ({
    ownerUserIdx: index("idx_multiplayer_remote_trusted_devices_owner_user").on(
      table.ownerUserId,
    ),
    deviceKeyHashIdx: index(
      "idx_multiplayer_remote_trusted_devices_device_key_hash",
    ).on(table.deviceKeyHash),
    activeOwnerDeviceUnique: uniqueIndex(
      "multiplayer_remote_trusted_devices_owner_device_unique",
    ).on(table.ownerUserId, table.deviceKeyHash),
  }),
);

export const multiplayerRemoteDisplayDevicesTable = pgTable(
  "multiplayer_remote_display_devices",
  {
    id: serial("id").primaryKey(),
    ownerUserId: integer("owner_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    publicId: text("public_id").notNull(),
    authTokenHash: text("auth_token_hash").notNull(),
    deviceName: text("device_name").notNull(),
    deviceType: text("device_type"),
    trustedAt: timestamp("trusted_at").defaultNow().notNull(),
    lastSeenAt: timestamp("last_seen_at"),
    lastHeartbeatAt: timestamp("last_heartbeat_at"),
    revokedAt: timestamp("revoked_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => ({
    ownerUserIdx: index("idx_multiplayer_remote_display_devices_owner_user").on(
      table.ownerUserId,
    ),
    publicIdIdx: uniqueIndex("multiplayer_remote_display_devices_public_id_unique").on(
      table.publicId,
    ),
    authTokenHashIdx: uniqueIndex(
      "multiplayer_remote_display_devices_auth_token_hash_unique",
    ).on(table.authTokenHash),
  }),
);

export const multiplayerRemoteSessionsTable = pgTable(
  "multiplayer_remote_sessions",
  {
    id: serial("id").primaryKey(),
    ownerUserId: integer("owner_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    displayDeviceId: integer("display_device_id").references(
      () => multiplayerRemoteDisplayDevicesTable.id,
      { onDelete: "set null" },
    ),
    displayClientId: text("display_client_id"),
    remoteClientId: text("remote_client_id"),
    pairingCode: text("pairing_code"),
    pairingCodeExpiresAt: timestamp("pairing_code_expires_at"),
    status: text("status").default("waiting_for_remote").notNull(),
    displayConnectedAt: timestamp("display_connected_at"),
    displayLastSeenAt: timestamp("display_last_seen_at"),
    remoteConnectedAt: timestamp("remote_connected_at"),
    remoteLastSeenAt: timestamp("remote_last_seen_at"),
    approvedAt: timestamp("approved_at"),
    closedAt: timestamp("closed_at"),
    closeReason: text("close_reason"),
    lastStateJson: json("last_state_json").$type<Record<string, unknown> | null>(),
    protocolVersion: integer("protocol_version").default(1).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => ({
    ownerUserIdx: index("idx_multiplayer_remote_sessions_owner_user").on(
      table.ownerUserId,
    ),
    displayDeviceIdx: index("idx_multiplayer_remote_sessions_display_device").on(
      table.displayDeviceId,
    ),
    statusIdx: index("idx_multiplayer_remote_sessions_status").on(table.status),
    displayClientIdx: index(
      "idx_multiplayer_remote_sessions_display_client",
    ).on(table.displayClientId),
    remoteClientIdx: index("idx_multiplayer_remote_sessions_remote_client").on(
      table.remoteClientId,
    ),
    pairingCodeUnique: uniqueIndex(
      "multiplayer_remote_sessions_pairing_code_unique",
    )
      .on(table.pairingCode)
      .where(sql`${table.pairingCode} IS NOT NULL`),
    statusCheck: check(
      "multiplayer_remote_sessions_status_check",
      sql`${table.status} IN ('waiting_for_remote', 'pending_approval', 'active', 'closed', 'expired')`,
    ),
    pairingCodeFormatCheck: check(
      "multiplayer_remote_sessions_pairing_code_format_check",
      sql`${table.pairingCode} IS NULL OR ${table.pairingCode} ~ '^[A-Z0-9]{6}$'`,
    ),
    protocolVersionCheck: check(
      "multiplayer_remote_sessions_protocol_version_check",
      sql`${table.protocolVersion} >= 1`,
    ),
  }),
);

export const multiplayerRemoteJoinRequestsTable = pgTable(
  "multiplayer_remote_join_requests",
  {
    id: serial("id").primaryKey(),
    sessionId: integer("session_id")
      .notNull()
      .references(() => multiplayerRemoteSessionsTable.id, {
        onDelete: "cascade",
      }),
    requestingUserId: integer("requesting_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    requestingSessionId: text("requesting_session_id").references(
      () => sessionsTable.id,
      { onDelete: "set null" },
    ),
    status: text("status").default("pending").notNull(),
    requestedCode: text("requested_code").notNull(),
    remoteDeviceKeyHash: text("remote_device_key_hash"),
    remoteDeviceName: text("remote_device_name"),
    remoteDeviceType: text("remote_device_type"),
    remoteUserAgent: text("remote_user_agent"),
    expiresAt: timestamp("expires_at").notNull(),
    resolvedAt: timestamp("resolved_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => ({
    sessionIdx: index("idx_multiplayer_remote_join_requests_session").on(
      table.sessionId,
    ),
    requestingUserIdx: index(
      "idx_multiplayer_remote_join_requests_requesting_user",
    ).on(table.requestingUserId),
    requestingSessionIdx: index(
      "idx_multiplayer_remote_join_requests_requesting_session",
    ).on(table.requestingSessionId),
    remoteDeviceKeyHashIdx: index(
      "idx_multiplayer_remote_join_requests_remote_device_key_hash",
    ).on(table.remoteDeviceKeyHash),
    statusIdx: index("idx_multiplayer_remote_join_requests_status").on(
      table.status,
    ),
    pendingSessionUnique: uniqueIndex(
      "multiplayer_remote_join_requests_pending_session_unique",
    )
      .on(table.sessionId)
      .where(sql`${table.status} = 'pending'`),
    statusCheck: check(
      "multiplayer_remote_join_requests_status_check",
      sql`${table.status} IN ('pending', 'approved', 'rejected', 'expired', 'cancelled')`,
    ),
    requestedCodeFormatCheck: check(
      "multiplayer_remote_join_requests_requested_code_format_check",
      sql`${table.requestedCode} ~ '^[A-Z0-9]{6}$'`,
    ),
  }),
);

export type MultiplayerRemoteSessionRecord =
  typeof multiplayerRemoteSessionsTable.$inferSelect;
export type NewMultiplayerRemoteSessionRecord =
  typeof multiplayerRemoteSessionsTable.$inferInsert;
export type MultiplayerRemoteJoinRequestRecord =
  typeof multiplayerRemoteJoinRequestsTable.$inferSelect;
export type NewMultiplayerRemoteJoinRequestRecord =
  typeof multiplayerRemoteJoinRequestsTable.$inferInsert;
export type MultiplayerRemoteTrustedDeviceRecord =
  typeof multiplayerRemoteTrustedDevicesTable.$inferSelect;
export type NewMultiplayerRemoteTrustedDeviceRecord =
  typeof multiplayerRemoteTrustedDevicesTable.$inferInsert;
export type MultiplayerRemoteDisplayDeviceRecord =
  typeof multiplayerRemoteDisplayDevicesTable.$inferSelect;
export type NewMultiplayerRemoteDisplayDeviceRecord =
  typeof multiplayerRemoteDisplayDevicesTable.$inferInsert;
