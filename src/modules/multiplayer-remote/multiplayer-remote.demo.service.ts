import { createHash } from "crypto";
import { demoRepository } from "@/database/demo";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "@/utils/errors";
import type {
  CloseSessionBody,
  PairBody,
  RegisterDisplayDeviceBody,
  SessionSnapshot,
  TrustedDeviceBody,
} from "./multiplayer-remote.schemas";
import {
  multiplayerRemoteProtocolVersion,
  type MultiplayerRemoteClientRole,
  type MultiplayerRemoteDeviceType,
} from "./multiplayer-remote.types";
import type {
  MultiplayerRemoteDisplayDeviceDto,
  MultiplayerRemoteJoinRequestDto,
  MultiplayerRemoteSessionDto,
  MultiplayerRemoteTrustedDeviceDto,
  MultiplayerRemoteTrustedSessionDiscoveryDto,
} from "./multiplayer-remote.service";

const KINDS = {
  session: "multiplayer-session",
  join: "multiplayer-join-request",
  trusted: "multiplayer-trusted-device",
  display: "multiplayer-display-device",
} as const;
const DEMO_TIME = "2026-08-01T12:00:00.000Z";

type StoredSession = MultiplayerRemoteSessionDto & {
  displayDeviceId: number | null;
};
type StoredTrusted = MultiplayerRemoteTrustedDeviceDto & {
  deviceKeyHash: string;
};
type StoredDisplay = MultiplayerRemoteDisplayDeviceDto & {
  authTokenHash: string;
};
type StoredJoin = MultiplayerRemoteJoinRequestDto & {
  remoteDeviceKeyHash: string | null;
};

function nextId(kind: string): number {
  return (
    Math.max(
      0,
      ...demoRepository.listResources(kind).map((item) => Number(item.id) || 0)
    ) + 1
  );
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function now(): string {
  return new Date().toISOString();
}

export class MultiplayerRemoteDemoService {
  private getOwnedSession(sessionId: number, userId: number): StoredSession {
    const session = demoRepository.getResource(
      KINDS.session,
      sessionId
    ) as StoredSession | null;
    if (!session || session.ownerUserId !== userId) {
      throw new NotFoundError(
        `Multiplayer session not found with id: ${sessionId}`
      );
    }
    return session;
  }

  private saveSession(session: StoredSession): StoredSession {
    session.updatedAt = now();
    demoRepository.putResource(KINDS.session, session.id, session);
    return session;
  }

  private pendingJoin(sessionId: number): StoredJoin | null {
    return (
      (demoRepository.listResources(KINDS.join) as StoredJoin[]).find(
        (item) => item.sessionId === sessionId && item.status === "pending"
      ) ?? null
    );
  }

  async createSession(
    ownerUserId: number
  ): Promise<MultiplayerRemoteSessionDto> {
    const id = nextId(KINDS.session);
    const session: StoredSession = {
      id,
      ownerUserId,
      displayClientId: null,
      remoteClientId: null,
      pairingCode: `DM${String(id).padStart(4, "0").slice(-4)}`,
      pairingCodeExpiresAt: "2099-01-01T00:00:00.000Z",
      status: "waiting_for_remote",
      displayConnectedAt: null,
      displayLastSeenAt: null,
      remoteConnectedAt: null,
      remoteLastSeenAt: null,
      approvedAt: null,
      closedAt: null,
      closeReason: null,
      lastState: null,
      protocolVersion: multiplayerRemoteProtocolVersion,
      createdAt: DEMO_TIME,
      updatedAt: DEMO_TIME,
      pendingJoinRequest: null,
      displayDeviceId: null,
    };
    demoRepository.putResource(KINDS.session, id, session);
    return session;
  }

  async getSession(
    sessionId: number,
    userId: number
  ): Promise<MultiplayerRemoteSessionDto> {
    const session = this.getOwnedSession(sessionId, userId);
    return { ...session, pendingJoinRequest: this.pendingJoin(sessionId) };
  }

  async getPendingJoinRequestForDisplay(
    sessionId: number,
    userId: number
  ): Promise<MultiplayerRemoteJoinRequestDto | null> {
    this.getOwnedSession(sessionId, userId);
    return this.pendingJoin(sessionId);
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
    const session = (
      demoRepository.listResources(KINDS.session) as StoredSession[]
    ).find((item) => item.pairingCode === input.pairingCode);
    if (!session) throw new NotFoundError("Pairing code not found");
    if (session.ownerUserId !== params.userId)
      throw new ForbiddenError("Pairing is only allowed for the session owner");
    if (!session.displayConnectedAt)
      throw new ConflictError("Display is not connected");
    if (session.status === "closed")
      throw new ConflictError("Session is already closed");
    const existing = this.pendingJoin(session.id);
    if (existing) return { sessionId: session.id, joinRequest: existing };
    const id = nextId(KINDS.join);
    const request: StoredJoin = {
      id,
      sessionId: session.id,
      requestingUserId: params.userId,
      requestingSessionId: params.authSessionId,
      status: "pending",
      requestedCode: input.pairingCode,
      canTrustDevice: Boolean(input.remoteDeviceKey),
      remoteDeviceName: input.remoteDeviceName ?? null,
      remoteDeviceType: input.remoteDeviceType ?? "unknown",
      remoteUserAgent: params.userAgent,
      expiresAt: "2099-01-01T00:00:00.000Z",
      resolvedAt: null,
      createdAt: DEMO_TIME,
      updatedAt: DEMO_TIME,
      remoteDeviceKeyHash: input.remoteDeviceKey
        ? hash(input.remoteDeviceKey)
        : null,
    };
    demoRepository.putResource(KINDS.join, id, request);
    session.status = "pending_approval";
    this.saveSession(session);
    return { sessionId: session.id, joinRequest: request };
  }

  async approveJoinRequest(
    sessionId: number,
    requestId: number,
    userId: number
  ): Promise<MultiplayerRemoteSessionDto> {
    const session = this.getOwnedSession(sessionId, userId);
    const request = demoRepository.getResource(
      KINDS.join,
      requestId
    ) as StoredJoin | null;
    if (!request || request.sessionId !== sessionId)
      throw new NotFoundError(`Join request not found with id: ${requestId}`);
    if (request.status !== "pending")
      throw new ConflictError("Join request has already been resolved");
    request.status = "approved";
    request.resolvedAt = now();
    request.updatedAt = request.resolvedAt;
    demoRepository.putResource(KINDS.join, request.id, request);
    if (request.remoteDeviceKeyHash) {
      const existing = (
        demoRepository.listResources(KINDS.trusted) as StoredTrusted[]
      ).find(
        (item) =>
          item.ownerUserId === userId &&
          item.deviceKeyHash === request.remoteDeviceKeyHash
      );
      const id = existing?.id ?? nextId(KINDS.trusted);
      const trusted: StoredTrusted = {
        id,
        ownerUserId: userId,
        deviceName: request.remoteDeviceName,
        deviceType: request.remoteDeviceType,
        userAgent: request.remoteUserAgent,
        trustedAt: DEMO_TIME,
        lastSeenAt: now(),
        revokedAt: null,
        createdAt: existing?.createdAt ?? DEMO_TIME,
        updatedAt: now(),
        deviceKeyHash: request.remoteDeviceKeyHash,
      };
      demoRepository.putResource(KINDS.trusted, id, trusted);
    }
    session.status = "active";
    session.pairingCode = null;
    session.pairingCodeExpiresAt = null;
    session.approvedAt = now();
    return this.saveSession(session);
  }

  private getTrusted(userId: number, key: string): StoredTrusted {
    const trusted = (
      demoRepository.listResources(KINDS.trusted) as StoredTrusted[]
    ).find(
      (item) =>
        item.ownerUserId === userId &&
        item.deviceKeyHash === hash(key) &&
        !item.revokedAt
    );
    if (!trusted) throw new ForbiddenError("Remote device is not trusted");
    return trusted;
  }

  async discoverTrustedSessions(
    userId: number,
    input: TrustedDeviceBody,
    params: { userAgent: string | null }
  ): Promise<{
    trustedDevice: MultiplayerRemoteTrustedDeviceDto;
    sessions: MultiplayerRemoteTrustedSessionDiscoveryDto[];
  }> {
    const trusted = this.getTrusted(userId, input.remoteDeviceKey);
    trusted.lastSeenAt = now();
    trusted.userAgent = params.userAgent ?? trusted.userAgent;
    demoRepository.putResource(KINDS.trusted, trusted.id, trusted);
    const sessions = (
      demoRepository.listResources(KINDS.session) as StoredSession[]
    )
      .filter(
        (session) =>
          session.ownerUserId === userId &&
          session.status !== "closed" &&
          Boolean(session.displayConnectedAt) &&
          !session.remoteClientId
      )
      .map((session) => ({
        ...session,
        displayDevice: session.displayDeviceId
          ? ((demoRepository.getResource(
              KINDS.display,
              session.displayDeviceId
            ) as StoredDisplay | null) ?? null)
          : null,
      }));
    return { trustedDevice: trusted, sessions };
  }

  async registerDisplayDevice(
    userId: number,
    input: RegisterDisplayDeviceBody,
    userAgent: string | null
  ): Promise<{
    displayDevice: MultiplayerRemoteDisplayDeviceDto;
    deviceSecret: string;
  }> {
    const id = nextId(KINDS.display);
    const deviceSecret = `demo-display-secret-${String(id).padStart(16, "0")}`;
    const device: StoredDisplay = {
      id,
      ownerUserId: userId,
      publicId: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
      deviceName: input.deviceName,
      deviceType: input.deviceType ?? "unknown",
      trustedAt: DEMO_TIME,
      lastSeenAt: userAgent ? DEMO_TIME : null,
      lastHeartbeatAt: null,
      revokedAt: null,
      createdAt: DEMO_TIME,
      updatedAt: DEMO_TIME,
      authTokenHash: hash(deviceSecret),
    };
    demoRepository.putResource(KINDS.display, id, device);
    return { displayDevice: device, deviceSecret };
  }

  async connectTrustedDevice(
    sessionId: number,
    userId: number,
    input: TrustedDeviceBody,
    params: { userAgent: string | null }
  ): Promise<{
    session: MultiplayerRemoteSessionDto;
    trustedDevice: MultiplayerRemoteTrustedDeviceDto;
  }> {
    const session = this.getOwnedSession(sessionId, userId);
    if (!session.displayConnectedAt)
      throw new ConflictError("Display is not connected");
    const trusted = this.getTrusted(userId, input.remoteDeviceKey);
    trusted.lastSeenAt = now();
    trusted.userAgent = params.userAgent ?? trusted.userAgent;
    demoRepository.putResource(KINDS.trusted, trusted.id, trusted);
    session.status = "active";
    session.approvedAt = now();
    session.pairingCode = null;
    session.pairingCodeExpiresAt = null;
    return { session: this.saveSession(session), trustedDevice: trusted };
  }

  async rejectJoinRequest(
    sessionId: number,
    requestId: number,
    userId: number
  ): Promise<MultiplayerRemoteSessionDto> {
    const session = this.getOwnedSession(sessionId, userId);
    const request = demoRepository.getResource(
      KINDS.join,
      requestId
    ) as StoredJoin | null;
    if (!request || request.sessionId !== sessionId)
      throw new NotFoundError(`Join request not found with id: ${requestId}`);
    if (request.status !== "pending")
      throw new ConflictError("Join request has already been resolved");
    request.status = "rejected";
    request.resolvedAt = now();
    demoRepository.putResource(KINDS.join, request.id, request);
    session.status = "waiting_for_remote";
    return this.saveSession(session);
  }

  async closeSession(
    sessionId: number,
    userId: number,
    input: CloseSessionBody = {}
  ): Promise<void> {
    this.getOwnedSession(sessionId, userId);
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
    if (params.snapshot.sessionId !== params.sessionId)
      throw new BadRequestError("Snapshot sessionId does not match connection");
    const session = this.getOwnedSession(params.sessionId, params.userId);
    if (session.displayClientId !== params.clientId)
      throw new ForbiddenError("Client is not bound to the display role");
    session.lastState = params.snapshot;
    return this.saveSession(session);
  }

  async getBoundSession(params: {
    sessionId: number;
    userId: number;
    role: MultiplayerRemoteClientRole;
    clientId: string;
  }): Promise<MultiplayerRemoteSessionDto> {
    const session = this.getOwnedSession(params.sessionId, params.userId);
    const expected =
      params.role === "display"
        ? session.displayClientId
        : session.remoteClientId;
    if (expected !== params.clientId)
      throw new ForbiddenError("Client is not bound to this session role");
    return session;
  }

  async isSessionClosed(sessionId: number): Promise<boolean> {
    const session = demoRepository.getResource(
      KINDS.session,
      sessionId
    ) as StoredSession | null;
    return !session || session.status === "closed" || Boolean(session.closedAt);
  }

  async bindClient(params: {
    sessionId: number;
    userId: number;
    role: MultiplayerRemoteClientRole;
    clientId?: string;
  }): Promise<MultiplayerRemoteSessionDto> {
    const session = this.getOwnedSession(params.sessionId, params.userId);
    if (session.status === "closed")
      throw new ConflictError("Session is closed");
    const clientId = params.clientId ?? `demo-${params.role}-${session.id}`;
    if (params.role === "display") {
      session.displayClientId = clientId;
      session.displayConnectedAt ??= now();
      session.displayLastSeenAt = now();
    } else {
      if (session.status !== "active" || !session.approvedAt)
        throw new ForbiddenError(
          "Remote has not been approved for this session"
        );
      if (session.remoteClientId && session.remoteClientId !== clientId)
        throw new ConflictError("Session already has an active remote");
      session.remoteClientId = clientId;
      session.remoteConnectedAt ??= now();
      session.remoteLastSeenAt = now();
    }
    return this.saveSession(session);
  }

  async bindDisplayDeviceClient(params: {
    deviceId: string;
    deviceSecret: string;
    clientId?: string;
    deviceName?: string;
    deviceType?: MultiplayerRemoteDeviceType;
    userAgent: string | null;
  }): Promise<MultiplayerRemoteSessionDto> {
    const device = (
      demoRepository.listResources(KINDS.display) as StoredDisplay[]
    ).find(
      (item) =>
        item.publicId === params.deviceId &&
        item.authTokenHash === hash(params.deviceSecret) &&
        !item.revokedAt
    );
    if (!device) throw new ForbiddenError("Display device is not authorized");
    device.deviceName = params.deviceName ?? device.deviceName;
    device.deviceType = params.deviceType ?? device.deviceType;
    device.lastSeenAt = now();
    device.lastHeartbeatAt = now();
    demoRepository.putResource(KINDS.display, device.id, device);
    let session = (
      demoRepository.listResources(KINDS.session) as StoredSession[]
    ).find(
      (item) =>
        item.ownerUserId === device.ownerUserId &&
        item.displayDeviceId === device.id &&
        item.status !== "closed"
    );
    if (!session) {
      session = (await this.createSession(device.ownerUserId)) as StoredSession;
      session.displayDeviceId = device.id;
    }
    session.displayClientId =
      params.clientId ?? `demo-display-device-${device.id}`;
    session.displayConnectedAt ??= now();
    session.displayLastSeenAt = now();
    return this.saveSession(session);
  }

  async disconnectClient(params: {
    sessionId: number;
    userId: number;
    role: MultiplayerRemoteClientRole;
    clientId: string;
  }): Promise<boolean> {
    const session = this.getOwnedSession(params.sessionId, params.userId);
    if (
      params.role === "display" &&
      session.displayClientId === params.clientId
    ) {
      if (session.displayDeviceId) {
        session.displayClientId = null;
        this.saveSession(session);
        return false;
      }
      await this.closeSessionInternal(session.id, "display_disconnected");
      return true;
    }
    if (
      params.role === "remote" &&
      session.remoteClientId === params.clientId
    ) {
      session.remoteClientId = null;
      session.remoteLastSeenAt = now();
      this.saveSession(session);
    }
    return false;
  }

  async heartbeatConnection(params: {
    sessionId: number;
    role: MultiplayerRemoteClientRole;
  }): Promise<void> {
    const session = demoRepository.getResource(
      KINDS.session,
      params.sessionId
    ) as StoredSession | null;
    if (!session) return;
    if (params.role === "display") session.displayLastSeenAt = now();
    else session.remoteLastSeenAt = now();
    this.saveSession(session);
  }

  async closeSessionInternal(sessionId: number, reason: string): Promise<void> {
    const session = demoRepository.getResource(
      KINDS.session,
      sessionId
    ) as StoredSession | null;
    if (!session) return;
    session.status = "closed";
    session.displayClientId = null;
    session.remoteClientId = null;
    session.pairingCode = null;
    session.pairingCodeExpiresAt = null;
    session.closedAt = now();
    session.closeReason = reason;
    this.saveSession(session);
  }
}

export const multiplayerRemoteDemoService = new MultiplayerRemoteDemoService();
