import { createHash, randomBytes, randomUUID } from "crypto";
import { and, desc, eq, gt, isNull, lte, ne, or } from "drizzle-orm";
import { db } from "@/config/drizzle";
import {
  multiplayerRemoteJoinRequestsTable,
  multiplayerRemoteDisplayDevicesTable,
  multiplayerRemoteSessionsTable,
  multiplayerRemoteTrustedDevicesTable,
  type MultiplayerRemoteDisplayDeviceRecord,
  type MultiplayerRemoteJoinRequestRecord,
  type MultiplayerRemoteSessionRecord,
  type MultiplayerRemoteTrustedDeviceRecord,
} from "@/database/schema";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "@/utils/errors";
import { logger } from "@/utils/logger";
import { env } from "@/config/env";
import { multiplayerRemoteDemoService } from "./multiplayer-remote.demo.service";
import {
  multiplayerRemoteProtocolVersion,
  type MultiplayerRemoteClientRole,
  type MultiplayerRemoteDeviceType,
  type MultiplayerRemoteJoinRequestStatus,
  type MultiplayerRemoteSessionStatus,
} from "./multiplayer-remote.types";
import type {
  CloseSessionBody,
  RegisterDisplayDeviceBody,
  PairBody,
  SessionSnapshot,
  TrustedDeviceBody,
} from "./multiplayer-remote.schemas";

const PAIRING_CODE_TTL_MS = 5 * 60 * 1000;
const JOIN_REQUEST_TTL_MS = 2 * 60 * 1000;
const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export interface MultiplayerRemoteJoinRequestDto {
  id: number;
  sessionId: number;
  requestingUserId: number;
  requestingSessionId: string | null;
  status: MultiplayerRemoteJoinRequestStatus;
  requestedCode: string;
  canTrustDevice: boolean;
  remoteDeviceName: string | null;
  remoteDeviceType: MultiplayerRemoteDeviceType | null;
  remoteUserAgent: string | null;
  expiresAt: string;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MultiplayerRemoteSessionDto {
  id: number;
  ownerUserId: number;
  displayClientId: string | null;
  remoteClientId: string | null;
  pairingCode: string | null;
  pairingCodeExpiresAt: string | null;
  status: MultiplayerRemoteSessionStatus;
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
  pendingJoinRequest?: MultiplayerRemoteJoinRequestDto | null;
}

export interface MultiplayerRemoteTrustedDeviceDto {
  id: number;
  ownerUserId: number;
  deviceName: string | null;
  deviceType: MultiplayerRemoteDeviceType | null;
  userAgent: string | null;
  trustedAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MultiplayerRemoteDisplayDeviceDto {
  id: number;
  ownerUserId: number;
  publicId: string;
  deviceName: string;
  deviceType: MultiplayerRemoteDeviceType | null;
  trustedAt: string;
  lastSeenAt: string | null;
  lastHeartbeatAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MultiplayerRemoteTrustedSessionDiscoveryDto extends MultiplayerRemoteSessionDto {
  displayDevice: MultiplayerRemoteDisplayDeviceDto | null;
}

class MultiplayerRemoteService {
  async createSession(
    ownerUserId: number
  ): Promise<MultiplayerRemoteSessionDto> {
    const pairingCode = await this.generateUniquePairingCode();
    const pairingCodeExpiresAt = new Date(Date.now() + PAIRING_CODE_TTL_MS);

    const [session] = await db
      .insert(multiplayerRemoteSessionsTable)
      .values({
        ownerUserId,
        pairingCode,
        pairingCodeExpiresAt,
        protocolVersion: multiplayerRemoteProtocolVersion,
      })
      .returning();

    if (!session) {
      throw new Error("Failed to create multiplayer remote session");
    }

    logger.info(
      { sessionId: session.id, ownerUserId },
      "Multiplayer session created"
    );
    return this.mapSession(session, null);
  }

  async getSession(
    sessionId: number,
    userId: number
  ): Promise<MultiplayerRemoteSessionDto> {
    await this.expireStaleJoinRequests(sessionId);
    const session = await this.getOwnedSession(sessionId, userId);
    const pendingJoinRequest = await this.getPendingJoinRequest(session.id);
    return this.mapSession(session, pendingJoinRequest);
  }

  async getPendingJoinRequestForDisplay(
    sessionId: number,
    userId: number
  ): Promise<MultiplayerRemoteJoinRequestDto | null> {
    await this.expireStaleJoinRequests(sessionId);
    await this.getOwnedSession(sessionId, userId);
    const request = await this.getPendingJoinRequest(sessionId);
    return request ? this.mapJoinRequest(request) : null;
  }

  async pair(
    input: PairBody,
    params: {
      userId: number;
      authSessionId: string | null;
      userAgent: string | null;
    }
  ): Promise<{
    sessionId: number;
    joinRequest: MultiplayerRemoteJoinRequestDto;
  }> {
    const now = new Date();
    const [session] = await db
      .select()
      .from(multiplayerRemoteSessionsTable)
      .where(eq(multiplayerRemoteSessionsTable.pairingCode, input.pairingCode))
      .limit(1);

    if (!session) {
      throw new NotFoundError("Pairing code not found");
    }

    if (session.ownerUserId !== params.userId) {
      throw new ForbiddenError("Pairing is only allowed for the session owner");
    }

    if (session.status === "closed" || session.closedAt) {
      throw new ConflictError("Session is already closed");
    }

    if (
      session.pairingCodeExpiresAt === null ||
      session.pairingCodeExpiresAt <= now
    ) {
      await this.expireSession(session.id);
      throw new BadRequestError("Pairing code has expired");
    }

    if (!session.displayConnectedAt) {
      throw new ConflictError("Display is not connected");
    }

    if (session.status === "active" || session.remoteClientId) {
      throw new ConflictError("Session already has an active remote");
    }

    await this.expireStaleJoinRequests(session.id, now);

    const existingPending = await this.getPendingJoinRequest(session.id);
    if (existingPending) {
      return {
        sessionId: session.id,
        joinRequest: this.mapJoinRequest(existingPending),
      };
    }

    const expiresAt = new Date(Date.now() + JOIN_REQUEST_TTL_MS);
    const [joinRequest] = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(multiplayerRemoteJoinRequestsTable)
        .values({
          sessionId: session.id,
          requestingUserId: params.userId,
          requestingSessionId: params.authSessionId,
          requestedCode: input.pairingCode,
          remoteDeviceKeyHash: input.remoteDeviceKey
            ? this.hashDeviceKey(input.remoteDeviceKey)
            : null,
          remoteDeviceName: input.remoteDeviceName ?? null,
          remoteDeviceType: input.remoteDeviceType ?? "unknown",
          remoteUserAgent: params.userAgent,
          expiresAt,
        })
        .returning();

      await tx
        .update(multiplayerRemoteSessionsTable)
        .set({ status: "pending_approval", updatedAt: now })
        .where(eq(multiplayerRemoteSessionsTable.id, session.id));

      return [created];
    });

    if (!joinRequest) {
      throw new Error("Failed to create join request");
    }

    logger.info(
      { sessionId: session.id, joinRequestId: joinRequest.id },
      "Multiplayer join request created"
    );

    return {
      sessionId: session.id,
      joinRequest: this.mapJoinRequest(joinRequest),
    };
  }

  async approveJoinRequest(
    sessionId: number,
    requestId: number,
    userId: number
  ): Promise<MultiplayerRemoteSessionDto> {
    const session = await this.getOwnedSession(sessionId, userId);
    const joinRequest = await this.getJoinRequest(sessionId, requestId);
    const now = new Date();

    await this.assertPendingJoinRequest(joinRequest, now);

    const [updatedSession] = await db.transaction(async (tx) => {
      await tx
        .update(multiplayerRemoteJoinRequestsTable)
        .set({ status: "approved", resolvedAt: now, updatedAt: now })
        .where(eq(multiplayerRemoteJoinRequestsTable.id, requestId));

      if (joinRequest.remoteDeviceKeyHash) {
        await tx
          .insert(multiplayerRemoteTrustedDevicesTable)
          .values({
            ownerUserId: userId,
            deviceKeyHash: joinRequest.remoteDeviceKeyHash,
            deviceName: joinRequest.remoteDeviceName,
            deviceType: joinRequest.remoteDeviceType,
            userAgent: joinRequest.remoteUserAgent,
            trustedAt: now,
            lastSeenAt: now,
          })
          .onConflictDoUpdate({
            target: [
              multiplayerRemoteTrustedDevicesTable.ownerUserId,
              multiplayerRemoteTrustedDevicesTable.deviceKeyHash,
            ],
            set: {
              deviceName: joinRequest.remoteDeviceName,
              deviceType: joinRequest.remoteDeviceType,
              userAgent: joinRequest.remoteUserAgent,
              trustedAt: now,
              lastSeenAt: now,
              revokedAt: null,
              updatedAt: now,
            },
          });
      }

      const [updated] = await tx
        .update(multiplayerRemoteSessionsTable)
        .set({
          status: "active",
          pairingCode: null,
          pairingCodeExpiresAt: null,
          approvedAt: now,
          updatedAt: now,
        })
        .where(eq(multiplayerRemoteSessionsTable.id, session.id))
        .returning();

      return [updated];
    });

    if (!updatedSession) {
      throw new Error("Failed to approve join request");
    }

    logger.info({ sessionId, requestId }, "Multiplayer join request approved");
    return this.mapSession(updatedSession, null);
  }

  async discoverTrustedSessions(
    userId: number,
    input: TrustedDeviceBody,
    params: {
      userAgent: string | null;
    }
  ): Promise<{
    trustedDevice: MultiplayerRemoteTrustedDeviceDto;
    sessions: MultiplayerRemoteTrustedSessionDiscoveryDto[];
  }> {
    const trustedDevice = await this.getTrustedDevice(
      userId,
      input.remoteDeviceKey
    );
    const touchedTrustedDevice = await this.touchTrustedDevice(
      trustedDevice,
      input,
      params.userAgent
    );

    const sessions = await db
      .select()
      .from(multiplayerRemoteSessionsTable)
      .where(
        and(
          eq(multiplayerRemoteSessionsTable.ownerUserId, userId),
          isNull(multiplayerRemoteSessionsTable.closedAt),
          isNull(multiplayerRemoteSessionsTable.remoteClientId),
          or(
            eq(multiplayerRemoteSessionsTable.status, "waiting_for_remote"),
            eq(multiplayerRemoteSessionsTable.status, "pending_approval")
          )
        )
      )
      .orderBy(desc(multiplayerRemoteSessionsTable.displayLastSeenAt))
      .limit(20);

    const displayDeviceIds = Array.from(
      new Set(
        sessions
          .map((session) => session.displayDeviceId)
          .filter((value): value is number => value !== null)
      )
    );
    const displayDevicesById =
      await this.getDisplayDevicesByIds(displayDeviceIds);

    return {
      trustedDevice: this.mapTrustedDevice(touchedTrustedDevice),
      sessions: sessions
        .filter((candidate) => Boolean(candidate.displayConnectedAt))
        .map((candidate) => ({
          ...this.mapSession(candidate, null),
          displayDevice:
            candidate.displayDeviceId !== null
              ? (displayDevicesById.get(candidate.displayDeviceId) ?? null)
              : null,
        })),
    };
  }

  async registerDisplayDevice(
    userId: number,
    input: RegisterDisplayDeviceBody,
    userAgent: string | null
  ): Promise<{
    displayDevice: MultiplayerRemoteDisplayDeviceDto;
    deviceSecret: string;
  }> {
    const now = new Date();
    const devicePublicId = randomUUID();
    const deviceSecret =
      randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");

    const [displayDevice] = await db
      .insert(multiplayerRemoteDisplayDevicesTable)
      .values({
        ownerUserId: userId,
        publicId: devicePublicId,
        authTokenHash: this.hashDeviceKey(deviceSecret),
        deviceName: input.deviceName,
        deviceType: input.deviceType ?? "unknown",
        trustedAt: now,
        lastSeenAt: userAgent ? now : null,
        lastHeartbeatAt: null,
      })
      .returning();

    if (!displayDevice) {
      throw new Error("Failed to register multiplayer display device");
    }

    return {
      displayDevice: this.mapDisplayDevice(displayDevice),
      deviceSecret,
    };
  }

  async connectTrustedDevice(
    sessionId: number,
    userId: number,
    input: TrustedDeviceBody,
    params: {
      userAgent: string | null;
    }
  ): Promise<{
    session: MultiplayerRemoteSessionDto;
    trustedDevice: MultiplayerRemoteTrustedDeviceDto;
  }> {
    const session = await this.getOwnedSession(sessionId, userId);
    const trustedDevice = await this.getTrustedDevice(
      userId,
      input.remoteDeviceKey
    );
    const now = new Date();

    if (session.status === "closed" || session.closedAt) {
      throw new ConflictError("Session is already closed");
    }

    if (!session.displayConnectedAt) {
      throw new ConflictError("Display is not connected");
    }

    if (session.status === "active" || session.remoteClientId) {
      throw new ConflictError("Session already has an active remote");
    }

    const [updatedSession, updatedTrustedDevice] = await db.transaction(
      async (tx) => {
        await tx
          .update(multiplayerRemoteJoinRequestsTable)
          .set({ status: "cancelled", resolvedAt: now, updatedAt: now })
          .where(
            and(
              eq(multiplayerRemoteJoinRequestsTable.sessionId, session.id),
              eq(multiplayerRemoteJoinRequestsTable.status, "pending")
            )
          );

        const [device] = await tx
          .update(multiplayerRemoteTrustedDevicesTable)
          .set({
            deviceName: input.remoteDeviceName ?? trustedDevice.deviceName,
            deviceType: input.remoteDeviceType ?? trustedDevice.deviceType,
            userAgent: params.userAgent ?? trustedDevice.userAgent,
            lastSeenAt: now,
            updatedAt: now,
          })
          .where(eq(multiplayerRemoteTrustedDevicesTable.id, trustedDevice.id))
          .returning();

        const [updated] = await tx
          .update(multiplayerRemoteSessionsTable)
          .set({
            status: "active",
            pairingCode: null,
            pairingCodeExpiresAt: null,
            approvedAt: now,
            updatedAt: now,
          })
          .where(eq(multiplayerRemoteSessionsTable.id, session.id))
          .returning();

        return [updated, device];
      }
    );

    if (!updatedSession || !updatedTrustedDevice) {
      throw new Error("Failed to connect trusted remote device");
    }

    logger.info(
      { sessionId, trustedDeviceId: trustedDevice.id },
      "Trusted multiplayer remote device connected"
    );

    return {
      session: this.mapSession(updatedSession, null),
      trustedDevice: this.mapTrustedDevice(updatedTrustedDevice),
    };
  }

  async rejectJoinRequest(
    sessionId: number,
    requestId: number,
    userId: number
  ): Promise<MultiplayerRemoteSessionDto> {
    const session = await this.getOwnedSession(sessionId, userId);
    const joinRequest = await this.getJoinRequest(sessionId, requestId);
    const now = new Date();

    await this.assertPendingJoinRequest(joinRequest, now);

    const [updatedSession] = await db.transaction(async (tx) => {
      await tx
        .update(multiplayerRemoteJoinRequestsTable)
        .set({ status: "rejected", resolvedAt: now, updatedAt: now })
        .where(eq(multiplayerRemoteJoinRequestsTable.id, requestId));

      const [updated] = await tx
        .update(multiplayerRemoteSessionsTable)
        .set({ status: "waiting_for_remote", updatedAt: now })
        .where(eq(multiplayerRemoteSessionsTable.id, session.id))
        .returning();

      return [updated];
    });

    if (!updatedSession) {
      throw new Error("Failed to reject join request");
    }

    logger.info({ sessionId, requestId }, "Multiplayer join request rejected");
    return this.mapSession(updatedSession, null);
  }

  async closeSession(
    sessionId: number,
    userId: number,
    input: CloseSessionBody = {}
  ): Promise<void> {
    await this.getOwnedSession(sessionId, userId);
    await this.closeSessionInternal(
      sessionId,
      input.reason ?? "closed_by_user"
    );
  }

  async updateSessionState(params: {
    sessionId: number;
    userId: number;
    clientId: string;
    snapshot: SessionSnapshot;
  }): Promise<MultiplayerRemoteSessionDto> {
    if (params.snapshot.sessionId !== params.sessionId) {
      throw new BadRequestError("Snapshot sessionId does not match connection");
    }

    const session = await this.getOwnedSession(params.sessionId, params.userId);
    if (session.status === "closed" || session.closedAt) {
      throw new ConflictError("Session is closed");
    }

    if (session.displayClientId !== params.clientId) {
      throw new ForbiddenError(
        "Only the bound display can update session state"
      );
    }

    const now = new Date();
    const [updated] = await db
      .update(multiplayerRemoteSessionsTable)
      .set({
        lastStateJson: params.snapshot,
        displayLastSeenAt: now,
        updatedAt: now,
      })
      .where(eq(multiplayerRemoteSessionsTable.id, params.sessionId))
      .returning();

    if (!updated) {
      throw new Error("Failed to update multiplayer session state");
    }

    return this.mapSession(
      updated,
      await this.getPendingJoinRequest(params.sessionId)
    );
  }

  async getBoundSession(params: {
    sessionId: number;
    userId: number;
    role: MultiplayerRemoteClientRole;
    clientId: string;
  }): Promise<MultiplayerRemoteSessionDto> {
    const session = await this.getOwnedSession(params.sessionId, params.userId);
    if (session.status === "closed" || session.closedAt) {
      throw new ConflictError("Session is closed");
    }

    const expectedClientId =
      params.role === "display"
        ? session.displayClientId
        : session.remoteClientId;

    if (expectedClientId !== params.clientId) {
      throw new ForbiddenError("Client is not bound to this session");
    }

    return this.mapSession(
      session,
      await this.getPendingJoinRequest(session.id)
    );
  }

  async isSessionClosed(sessionId: number): Promise<boolean> {
    const [session] = await db
      .select({
        status: multiplayerRemoteSessionsTable.status,
        closedAt: multiplayerRemoteSessionsTable.closedAt,
      })
      .from(multiplayerRemoteSessionsTable)
      .where(eq(multiplayerRemoteSessionsTable.id, sessionId))
      .limit(1);

    return !session || session.status === "closed" || Boolean(session.closedAt);
  }

  async bindClient(params: {
    sessionId: number;
    userId: number;
    role: MultiplayerRemoteClientRole;
    clientId?: string;
  }): Promise<MultiplayerRemoteSessionDto> {
    await this.expireStaleJoinRequests(params.sessionId);
    const session = await this.getOwnedSession(params.sessionId, params.userId);
    if (session.status === "closed" || session.closedAt) {
      throw new ConflictError("Session is closed");
    }

    const now = new Date();
    const clientId = params.clientId ?? randomUUID();

    if (params.role === "display") {
      const [updated] = await db
        .update(multiplayerRemoteSessionsTable)
        .set({
          displayClientId: clientId,
          displayConnectedAt: session.displayConnectedAt ?? now,
          displayLastSeenAt: now,
          updatedAt: now,
        })
        .where(eq(multiplayerRemoteSessionsTable.id, session.id))
        .returning();

      return this.mapSession(
        updated ?? session,
        await this.getPendingJoinRequest(session.id)
      );
    }

    if (session.status !== "active" || !session.approvedAt) {
      throw new ForbiddenError("Remote has not been approved for this session");
    }

    if (session.remoteClientId && session.remoteClientId !== clientId) {
      throw new ConflictError("Session already has an active remote");
    }

    const [updated] = await db
      .update(multiplayerRemoteSessionsTable)
      .set({
        remoteClientId: clientId,
        remoteConnectedAt: session.remoteConnectedAt ?? now,
        remoteLastSeenAt: now,
        updatedAt: now,
      })
      .where(eq(multiplayerRemoteSessionsTable.id, session.id))
      .returning();

    return this.mapSession(updated ?? session, null);
  }

  async bindDisplayDeviceClient(params: {
    deviceId: string;
    deviceSecret: string;
    clientId?: string;
    deviceName?: string;
    deviceType?: MultiplayerRemoteDeviceType;
    userAgent: string | null;
  }): Promise<MultiplayerRemoteSessionDto> {
    const displayDevice = await this.authenticateDisplayDevice(
      params.deviceId,
      params.deviceSecret
    );
    const now = new Date();
    const clientId = params.clientId ?? randomUUID();

    const [updatedSession] = await db.transaction(async (tx) => {
      const [device] = await tx
        .update(multiplayerRemoteDisplayDevicesTable)
        .set({
          deviceName: params.deviceName ?? displayDevice.deviceName,
          deviceType: params.deviceType ?? displayDevice.deviceType,
          lastSeenAt: now,
          lastHeartbeatAt: now,
          updatedAt: now,
        })
        .where(eq(multiplayerRemoteDisplayDevicesTable.id, displayDevice.id))
        .returning();

      if (!device) {
        throw new Error("Failed to update multiplayer display device");
      }

      const reusableSession =
        await tx.query.multiplayerRemoteSessionsTable.findFirst({
          where: (sessions, { and, eq, isNull, or }) =>
            and(
              eq(sessions.ownerUserId, displayDevice.ownerUserId),
              eq(sessions.displayDeviceId, displayDevice.id),
              isNull(sessions.closedAt),
              or(
                eq(sessions.status, "waiting_for_remote"),
                eq(sessions.status, "pending_approval"),
                eq(sessions.status, "active")
              )
            ),
          orderBy: (sessions, { desc }) => [desc(sessions.updatedAt)],
        });

      if (reusableSession) {
        const [updated] = await tx
          .update(multiplayerRemoteSessionsTable)
          .set({
            displayClientId: clientId,
            displayConnectedAt: reusableSession.displayConnectedAt ?? now,
            displayLastSeenAt: now,
            updatedAt: now,
          })
          .where(eq(multiplayerRemoteSessionsTable.id, reusableSession.id))
          .returning();

        return [updated];
      }

      const [created] = await tx
        .insert(multiplayerRemoteSessionsTable)
        .values({
          ownerUserId: displayDevice.ownerUserId,
          displayDeviceId: displayDevice.id,
          displayClientId: clientId,
          displayConnectedAt: now,
          displayLastSeenAt: now,
          protocolVersion: multiplayerRemoteProtocolVersion,
        })
        .returning();

      return [created];
    });

    if (!updatedSession) {
      throw new Error("Failed to bind multiplayer display device");
    }

    return this.mapSession(
      updatedSession,
      await this.getPendingJoinRequest(updatedSession.id)
    );
  }

  async disconnectClient(params: {
    sessionId: number;
    userId: number;
    role: MultiplayerRemoteClientRole;
    clientId: string;
  }): Promise<boolean> {
    const [session] = await db
      .select()
      .from(multiplayerRemoteSessionsTable)
      .where(eq(multiplayerRemoteSessionsTable.id, params.sessionId))
      .limit(1);

    if (!session || session.ownerUserId !== params.userId || session.closedAt) {
      return false;
    }

    const now = new Date();
    if (
      params.role === "display" &&
      session.displayClientId === params.clientId
    ) {
      if (session.displayDeviceId !== null) {
        // Persistent display: keep the session alive so it can be reclaimed on reconnect.
        await db
          .update(multiplayerRemoteSessionsTable)
          .set({
            displayClientId: null,
            displayLastSeenAt: now,
            updatedAt: now,
          })
          .where(eq(multiplayerRemoteSessionsTable.id, params.sessionId));
        return false;
      }
      await this.closeSessionInternal(params.sessionId, "display_disconnected");
      return true;
    }

    if (
      params.role === "remote" &&
      session.remoteClientId === params.clientId
    ) {
      await db
        .update(multiplayerRemoteSessionsTable)
        .set({
          remoteClientId: null,
          remoteLastSeenAt: now,
          updatedAt: now,
        })
        .where(eq(multiplayerRemoteSessionsTable.id, params.sessionId));
    }
    return false;
  }

  async heartbeatConnection(params: {
    sessionId: number;
    role: MultiplayerRemoteClientRole;
  }): Promise<void> {
    const now = new Date();
    const updateFields =
      params.role === "display"
        ? {
            displayLastSeenAt: now,
            updatedAt: now,
          }
        : {
            remoteLastSeenAt: now,
            updatedAt: now,
          };

    const [session] = await db
      .update(multiplayerRemoteSessionsTable)
      .set(updateFields)
      .where(eq(multiplayerRemoteSessionsTable.id, params.sessionId))
      .returning({
        displayDeviceId: multiplayerRemoteSessionsTable.displayDeviceId,
      });

    if (params.role !== "display" || !session?.displayDeviceId) {
      return;
    }

    await db
      .update(multiplayerRemoteDisplayDevicesTable)
      .set({
        lastSeenAt: now,
        lastHeartbeatAt: now,
        updatedAt: now,
      })
      .where(
        eq(multiplayerRemoteDisplayDevicesTable.id, session.displayDeviceId)
      );
  }

  async closeSessionInternal(sessionId: number, reason: string): Promise<void> {
    const now = new Date();
    await db.transaction(async (tx) => {
      await tx
        .update(multiplayerRemoteJoinRequestsTable)
        .set({ status: "cancelled", resolvedAt: now, updatedAt: now })
        .where(
          and(
            eq(multiplayerRemoteJoinRequestsTable.sessionId, sessionId),
            eq(multiplayerRemoteJoinRequestsTable.status, "pending")
          )
        );

      await tx
        .update(multiplayerRemoteSessionsTable)
        .set({
          status: "closed",
          displayClientId: null,
          remoteClientId: null,
          pairingCode: null,
          pairingCodeExpiresAt: null,
          closedAt: now,
          closeReason: reason,
          updatedAt: now,
        })
        .where(eq(multiplayerRemoteSessionsTable.id, sessionId));
    });

    logger.info({ sessionId, reason }, "Multiplayer session closed");
  }

  private async getOwnedSession(
    sessionId: number,
    userId: number
  ): Promise<MultiplayerRemoteSessionRecord> {
    const [session] = await db
      .select()
      .from(multiplayerRemoteSessionsTable)
      .where(
        and(
          eq(multiplayerRemoteSessionsTable.id, sessionId),
          eq(multiplayerRemoteSessionsTable.ownerUserId, userId)
        )
      )
      .limit(1);

    if (!session) {
      throw new NotFoundError(
        `Multiplayer session not found with id: ${sessionId}`
      );
    }

    return session;
  }

  private async getJoinRequest(
    sessionId: number,
    requestId: number
  ): Promise<MultiplayerRemoteJoinRequestRecord> {
    const [joinRequest] = await db
      .select()
      .from(multiplayerRemoteJoinRequestsTable)
      .where(
        and(
          eq(multiplayerRemoteJoinRequestsTable.id, requestId),
          eq(multiplayerRemoteJoinRequestsTable.sessionId, sessionId)
        )
      )
      .limit(1);

    if (!joinRequest) {
      throw new NotFoundError(`Join request not found with id: ${requestId}`);
    }

    return joinRequest;
  }

  private async getPendingJoinRequest(
    sessionId: number
  ): Promise<MultiplayerRemoteJoinRequestRecord | null> {
    const [joinRequest] = await db
      .select()
      .from(multiplayerRemoteJoinRequestsTable)
      .where(
        and(
          eq(multiplayerRemoteJoinRequestsTable.sessionId, sessionId),
          eq(multiplayerRemoteJoinRequestsTable.status, "pending"),
          gt(multiplayerRemoteJoinRequestsTable.expiresAt, new Date())
        )
      )
      .limit(1);

    return joinRequest ?? null;
  }

  private async assertPendingJoinRequest(
    joinRequest: MultiplayerRemoteJoinRequestRecord,
    now: Date
  ): Promise<void> {
    if (joinRequest.status !== "pending") {
      throw new ConflictError("Join request has already been resolved");
    }

    if (joinRequest.expiresAt <= now) {
      await this.expireStaleJoinRequests(joinRequest.sessionId, now);
      throw new BadRequestError("Join request has expired");
    }
  }

  private async expireStaleJoinRequests(
    sessionId: number,
    now = new Date()
  ): Promise<void> {
    const expiredRequests = await db
      .update(multiplayerRemoteJoinRequestsTable)
      .set({ status: "expired", resolvedAt: now, updatedAt: now })
      .where(
        and(
          eq(multiplayerRemoteJoinRequestsTable.sessionId, sessionId),
          eq(multiplayerRemoteJoinRequestsTable.status, "pending"),
          lte(multiplayerRemoteJoinRequestsTable.expiresAt, now)
        )
      )
      .returning({ id: multiplayerRemoteJoinRequestsTable.id });

    if (expiredRequests.length === 0) {
      return;
    }

    const [session] = await db
      .select({
        id: multiplayerRemoteSessionsTable.id,
        status: multiplayerRemoteSessionsTable.status,
      })
      .from(multiplayerRemoteSessionsTable)
      .where(eq(multiplayerRemoteSessionsTable.id, sessionId))
      .limit(1);

    if (session?.status === "pending_approval") {
      await db
        .update(multiplayerRemoteSessionsTable)
        .set({ status: "waiting_for_remote", updatedAt: now })
        .where(eq(multiplayerRemoteSessionsTable.id, sessionId));
    }

    logger.info(
      {
        sessionId,
        expiredJoinRequestIds: expiredRequests.map((request) => request.id),
      },
      "Expired stale multiplayer join requests"
    );
  }

  private async expireSession(sessionId: number): Promise<void> {
    await db
      .update(multiplayerRemoteSessionsTable)
      .set({
        status: "expired",
        pairingCode: null,
        pairingCodeExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(multiplayerRemoteSessionsTable.id, sessionId),
          ne(multiplayerRemoteSessionsTable.status, "closed")
        )
      );
  }

  private async generateUniquePairingCode(): Promise<string> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const code = this.generatePairingCode();
      const existing = await db
        .select({ id: multiplayerRemoteSessionsTable.id })
        .from(multiplayerRemoteSessionsTable)
        .where(
          and(
            eq(multiplayerRemoteSessionsTable.pairingCode, code),
            isNull(multiplayerRemoteSessionsTable.closedAt)
          )
        )
        .limit(1);

      if (!existing[0]) {
        return code;
      }
    }

    throw new Error("Failed to generate unique pairing code");
  }

  private generatePairingCode(): string {
    const bytes = randomBytes(6);
    return Array.from(
      bytes,
      (byte) => PAIRING_CODE_ALPHABET[byte % PAIRING_CODE_ALPHABET.length]
    ).join("");
  }

  private mapSession(
    session: MultiplayerRemoteSessionRecord,
    pendingJoinRequest: MultiplayerRemoteJoinRequestRecord | null
  ): MultiplayerRemoteSessionDto {
    return {
      id: session.id,
      ownerUserId: session.ownerUserId,
      displayClientId: session.displayClientId,
      remoteClientId: session.remoteClientId,
      pairingCode: session.pairingCode,
      pairingCodeExpiresAt: this.dateToIso(session.pairingCodeExpiresAt),
      status: session.status as MultiplayerRemoteSessionStatus,
      displayConnectedAt: this.dateToIso(session.displayConnectedAt),
      displayLastSeenAt: this.dateToIso(session.displayLastSeenAt),
      remoteConnectedAt: this.dateToIso(session.remoteConnectedAt),
      remoteLastSeenAt: this.dateToIso(session.remoteLastSeenAt),
      approvedAt: this.dateToIso(session.approvedAt),
      closedAt: this.dateToIso(session.closedAt),
      closeReason: session.closeReason,
      lastState: session.lastStateJson as SessionSnapshot | null,
      protocolVersion: session.protocolVersion,
      createdAt: session.createdAt.toISOString(),
      updatedAt: session.updatedAt.toISOString(),
      pendingJoinRequest: pendingJoinRequest
        ? this.mapJoinRequest(pendingJoinRequest)
        : null,
    };
  }

  private mapJoinRequest(
    joinRequest: MultiplayerRemoteJoinRequestRecord
  ): MultiplayerRemoteJoinRequestDto {
    return {
      id: joinRequest.id,
      sessionId: joinRequest.sessionId,
      requestingUserId: joinRequest.requestingUserId,
      requestingSessionId: joinRequest.requestingSessionId,
      status: joinRequest.status as MultiplayerRemoteJoinRequestStatus,
      requestedCode: joinRequest.requestedCode,
      canTrustDevice: Boolean(joinRequest.remoteDeviceKeyHash),
      remoteDeviceName: joinRequest.remoteDeviceName,
      remoteDeviceType:
        joinRequest.remoteDeviceType as MultiplayerRemoteDeviceType | null,
      remoteUserAgent: joinRequest.remoteUserAgent,
      expiresAt: joinRequest.expiresAt.toISOString(),
      resolvedAt: this.dateToIso(joinRequest.resolvedAt),
      createdAt: joinRequest.createdAt.toISOString(),
      updatedAt: joinRequest.updatedAt.toISOString(),
    };
  }

  private dateToIso(value: Date | null): string | null {
    return value ? value.toISOString() : null;
  }

  private async getTrustedDevice(
    userId: number,
    remoteDeviceKey: string
  ): Promise<MultiplayerRemoteTrustedDeviceRecord> {
    const [trustedDevice] = await db
      .select()
      .from(multiplayerRemoteTrustedDevicesTable)
      .where(
        and(
          eq(multiplayerRemoteTrustedDevicesTable.ownerUserId, userId),
          eq(
            multiplayerRemoteTrustedDevicesTable.deviceKeyHash,
            this.hashDeviceKey(remoteDeviceKey)
          ),
          isNull(multiplayerRemoteTrustedDevicesTable.revokedAt)
        )
      )
      .limit(1);

    if (!trustedDevice) {
      throw new ForbiddenError("Remote device is not trusted");
    }

    return trustedDevice;
  }

  private async authenticateDisplayDevice(
    deviceId: string,
    deviceSecret: string
  ): Promise<MultiplayerRemoteDisplayDeviceRecord> {
    const [displayDevice] = await db
      .select()
      .from(multiplayerRemoteDisplayDevicesTable)
      .where(
        and(
          eq(multiplayerRemoteDisplayDevicesTable.publicId, deviceId),
          eq(
            multiplayerRemoteDisplayDevicesTable.authTokenHash,
            this.hashDeviceKey(deviceSecret)
          ),
          isNull(multiplayerRemoteDisplayDevicesTable.revokedAt)
        )
      )
      .limit(1);

    if (!displayDevice) {
      throw new ForbiddenError("Display device is not authorized");
    }

    return displayDevice;
  }

  private async getDisplayDevicesByIds(
    displayDeviceIds: number[]
  ): Promise<Map<number, MultiplayerRemoteDisplayDeviceDto>> {
    if (displayDeviceIds.length === 0) {
      return new Map();
    }

    const displayDevices =
      await db.query.multiplayerRemoteDisplayDevicesTable.findMany({
        where: (displayDevices, { inArray, isNull }) =>
          and(
            inArray(displayDevices.id, displayDeviceIds),
            isNull(displayDevices.revokedAt)
          ),
      });

    return new Map(
      displayDevices.map((displayDevice) => [
        displayDevice.id,
        this.mapDisplayDevice(displayDevice),
      ])
    );
  }

  private async touchTrustedDevice(
    trustedDevice: MultiplayerRemoteTrustedDeviceRecord,
    input: TrustedDeviceBody,
    userAgent: string | null
  ): Promise<MultiplayerRemoteTrustedDeviceRecord> {
    const now = new Date();
    const [updated] = await db
      .update(multiplayerRemoteTrustedDevicesTable)
      .set({
        deviceName: input.remoteDeviceName ?? trustedDevice.deviceName,
        deviceType: input.remoteDeviceType ?? trustedDevice.deviceType,
        userAgent: userAgent ?? trustedDevice.userAgent,
        lastSeenAt: now,
        updatedAt: now,
      })
      .where(eq(multiplayerRemoteTrustedDevicesTable.id, trustedDevice.id))
      .returning();

    return updated ?? trustedDevice;
  }

  private mapTrustedDevice(
    trustedDevice: MultiplayerRemoteTrustedDeviceRecord
  ): MultiplayerRemoteTrustedDeviceDto {
    return {
      id: trustedDevice.id,
      ownerUserId: trustedDevice.ownerUserId,
      deviceName: trustedDevice.deviceName,
      deviceType:
        trustedDevice.deviceType as MultiplayerRemoteDeviceType | null,
      userAgent: trustedDevice.userAgent,
      trustedAt: trustedDevice.trustedAt.toISOString(),
      lastSeenAt: this.dateToIso(trustedDevice.lastSeenAt),
      revokedAt: this.dateToIso(trustedDevice.revokedAt),
      createdAt: trustedDevice.createdAt.toISOString(),
      updatedAt: trustedDevice.updatedAt.toISOString(),
    };
  }

  private mapDisplayDevice(
    displayDevice: MultiplayerRemoteDisplayDeviceRecord
  ): MultiplayerRemoteDisplayDeviceDto {
    return {
      id: displayDevice.id,
      ownerUserId: displayDevice.ownerUserId,
      publicId: displayDevice.publicId,
      deviceName: displayDevice.deviceName,
      deviceType:
        displayDevice.deviceType as MultiplayerRemoteDeviceType | null,
      trustedAt: displayDevice.trustedAt.toISOString(),
      lastSeenAt: this.dateToIso(displayDevice.lastSeenAt),
      lastHeartbeatAt: this.dateToIso(displayDevice.lastHeartbeatAt),
      revokedAt: this.dateToIso(displayDevice.revokedAt),
      createdAt: displayDevice.createdAt.toISOString(),
      updatedAt: displayDevice.updatedAt.toISOString(),
    };
  }

  private hashDeviceKey(remoteDeviceKey: string): string {
    return createHash("sha256").update(remoteDeviceKey).digest("hex");
  }
}

export const multiplayerRemoteService = env.DEMO_MODE
  ? multiplayerRemoteDemoService
  : new MultiplayerRemoteService();
