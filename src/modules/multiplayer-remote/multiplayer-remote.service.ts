import { randomBytes, randomUUID } from "crypto";
import { and, eq, gt, isNull, lte, ne } from "drizzle-orm";
import { db } from "@/config/drizzle";
import {
  multiplayerRemoteJoinRequestsTable,
  multiplayerRemoteSessionsTable,
  type MultiplayerRemoteJoinRequestRecord,
  type MultiplayerRemoteSessionRecord,
} from "@/database/schema";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "@/utils/errors";
import { logger } from "@/utils/logger";
import {
  multiplayerRemoteProtocolVersion,
  type MultiplayerRemoteClientRole,
  type MultiplayerRemoteDeviceType,
  type MultiplayerRemoteJoinRequestStatus,
  type MultiplayerRemoteSessionStatus,
} from "./multiplayer-remote.types";
import type {
  CloseSessionBody,
  PairBody,
  SessionSnapshot,
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

class MultiplayerRemoteService {
  async createSession(ownerUserId: number): Promise<MultiplayerRemoteSessionDto> {
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

    logger.info({ sessionId: session.id, ownerUserId }, "Multiplayer session created");
    return this.mapSession(session, null);
  }

  async getSession(
    sessionId: number,
    userId: number,
  ): Promise<MultiplayerRemoteSessionDto> {
    await this.expireStaleJoinRequests(sessionId);
    const session = await this.getOwnedSession(sessionId, userId);
    const pendingJoinRequest = await this.getPendingJoinRequest(session.id);
    return this.mapSession(session, pendingJoinRequest);
  }

  async getPendingJoinRequestForDisplay(
    sessionId: number,
    userId: number,
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
    },
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
      "Multiplayer join request created",
    );

    return {
      sessionId: session.id,
      joinRequest: this.mapJoinRequest(joinRequest),
    };
  }

  async approveJoinRequest(
    sessionId: number,
    requestId: number,
    userId: number,
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

  async rejectJoinRequest(
    sessionId: number,
    requestId: number,
    userId: number,
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
    input: CloseSessionBody = {},
  ): Promise<void> {
    await this.getOwnedSession(sessionId, userId);
    await this.closeSessionInternal(sessionId, input.reason ?? "closed_by_user");
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
      throw new ForbiddenError("Only the bound display can update session state");
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

    return this.mapSession(updated, await this.getPendingJoinRequest(params.sessionId));
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

    return this.mapSession(session, await this.getPendingJoinRequest(session.id));
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

      return this.mapSession(updated ?? session, await this.getPendingJoinRequest(session.id));
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

  async disconnectClient(params: {
    sessionId: number;
    userId: number;
    role: MultiplayerRemoteClientRole;
    clientId: string;
  }): Promise<void> {
    const [session] = await db
      .select()
      .from(multiplayerRemoteSessionsTable)
      .where(eq(multiplayerRemoteSessionsTable.id, params.sessionId))
      .limit(1);

    if (!session || session.ownerUserId !== params.userId || session.closedAt) {
      return;
    }

    const now = new Date();
    if (params.role === "display" && session.displayClientId === params.clientId) {
      await this.closeSessionInternal(params.sessionId, "display_disconnected");
      return;
    }

    if (params.role === "remote" && session.remoteClientId === params.clientId) {
      await db
        .update(multiplayerRemoteSessionsTable)
        .set({
          remoteClientId: null,
          remoteLastSeenAt: now,
          updatedAt: now,
        })
        .where(eq(multiplayerRemoteSessionsTable.id, params.sessionId));
    }
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
            eq(multiplayerRemoteJoinRequestsTable.status, "pending"),
          ),
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
    userId: number,
  ): Promise<MultiplayerRemoteSessionRecord> {
    const [session] = await db
      .select()
      .from(multiplayerRemoteSessionsTable)
      .where(
        and(
          eq(multiplayerRemoteSessionsTable.id, sessionId),
          eq(multiplayerRemoteSessionsTable.ownerUserId, userId),
        ),
      )
      .limit(1);

    if (!session) {
      throw new NotFoundError(`Multiplayer session not found with id: ${sessionId}`);
    }

    return session;
  }

  private async getJoinRequest(
    sessionId: number,
    requestId: number,
  ): Promise<MultiplayerRemoteJoinRequestRecord> {
    const [joinRequest] = await db
      .select()
      .from(multiplayerRemoteJoinRequestsTable)
      .where(
        and(
          eq(multiplayerRemoteJoinRequestsTable.id, requestId),
          eq(multiplayerRemoteJoinRequestsTable.sessionId, sessionId),
        ),
      )
      .limit(1);

    if (!joinRequest) {
      throw new NotFoundError(`Join request not found with id: ${requestId}`);
    }

    return joinRequest;
  }

  private async getPendingJoinRequest(
    sessionId: number,
  ): Promise<MultiplayerRemoteJoinRequestRecord | null> {
    const [joinRequest] = await db
      .select()
      .from(multiplayerRemoteJoinRequestsTable)
      .where(
        and(
          eq(multiplayerRemoteJoinRequestsTable.sessionId, sessionId),
          eq(multiplayerRemoteJoinRequestsTable.status, "pending"),
          gt(multiplayerRemoteJoinRequestsTable.expiresAt, new Date()),
        ),
      )
      .limit(1);

    return joinRequest ?? null;
  }

  private async assertPendingJoinRequest(
    joinRequest: MultiplayerRemoteJoinRequestRecord,
    now: Date,
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
    now = new Date(),
  ): Promise<void> {
    const expiredRequests = await db
      .update(multiplayerRemoteJoinRequestsTable)
      .set({ status: "expired", resolvedAt: now, updatedAt: now })
      .where(
        and(
          eq(multiplayerRemoteJoinRequestsTable.sessionId, sessionId),
          eq(multiplayerRemoteJoinRequestsTable.status, "pending"),
          lte(multiplayerRemoteJoinRequestsTable.expiresAt, now),
        ),
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
      "Expired stale multiplayer join requests",
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
          ne(multiplayerRemoteSessionsTable.status, "closed"),
        ),
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
            isNull(multiplayerRemoteSessionsTable.closedAt),
          ),
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
    return Array.from(bytes, (byte) => PAIRING_CODE_ALPHABET[byte % PAIRING_CODE_ALPHABET.length]).join("");
  }

  private mapSession(
    session: MultiplayerRemoteSessionRecord,
    pendingJoinRequest: MultiplayerRemoteJoinRequestRecord | null,
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
    joinRequest: MultiplayerRemoteJoinRequestRecord,
  ): MultiplayerRemoteJoinRequestDto {
    return {
      id: joinRequest.id,
      sessionId: joinRequest.sessionId,
      requestingUserId: joinRequest.requestingUserId,
      requestingSessionId: joinRequest.requestingSessionId,
      status: joinRequest.status as MultiplayerRemoteJoinRequestStatus,
      requestedCode: joinRequest.requestedCode,
      remoteDeviceName: joinRequest.remoteDeviceName,
      remoteDeviceType: joinRequest.remoteDeviceType as
        | MultiplayerRemoteDeviceType
        | null,
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
}

export const multiplayerRemoteService = new MultiplayerRemoteService();
