import type { FastifyInstance } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import { randomUUID } from "crypto";
import { optionalAuth } from "@/modules/auth/auth.middleware";
import { UnauthorizedError } from "@/utils/errors";
import { logger } from "@/utils/logger";
import { multiplayerRemoteService } from "./multiplayer-remote.service";
import {
  commandAckEventSchema,
  commandFailedEventSchema,
  commandRequestEventSchema,
  clientHelloEventSchema,
  playbackStateEventSchema,
  sessionStateEventSchema,
  websocketEventEnvelopeSchema,
} from "./multiplayer-remote.schemas";
import type {
  MultiplayerRemoteJoinRequestDto,
  MultiplayerRemoteSessionDto,
} from "./multiplayer-remote.service";
import {
  multiplayerRemoteProtocolVersion,
  type MultiplayerRemoteClientRole,
  type MultiplayerRemoteEventEnvelope,
} from "./multiplayer-remote.types";

interface BoundConnection {
  socket: WebSocket;
  sessionId: number;
  userId: number;
  role: MultiplayerRemoteClientRole;
  clientId: string;
  heartbeatInterval: ReturnType<typeof setInterval>;
}

const HEARTBEAT_INTERVAL_MS = 10_000;
const WEBSOCKET_OPEN_STATE = 1;

class MultiplayerRemoteWebSocketService {
  private connections = new Map<WebSocket, BoundConnection>();
  private displayConnections = new Map<number, WebSocket>();
  private remoteConnections = new Map<number, WebSocket>();

  notifyJoinRequested(
    sessionId: number,
    joinRequest: MultiplayerRemoteJoinRequestDto,
  ): void {
    const display = this.displayConnections.get(sessionId);
    if (!display) {
      return;
    }

    this.send(
      display,
      this.createEnvelope(
        "session.join_requested",
        {
          joinRequest,
        },
        sessionId,
      ),
    );

    logger.info(
      { sessionId, joinRequestId: joinRequest.id },
      "Sent multiplayer join request notification",
    );
  }

  notifyJoinApproved(session: MultiplayerRemoteSessionDto): void {
    const payload = { session };
    const display = this.displayConnections.get(session.id);
    const remote = this.remoteConnections.get(session.id);

    if (display) {
      this.send(
        display,
        this.createEnvelope("session.join_approved", payload, session.id),
      );
    }

    if (remote) {
      this.send(
        remote,
        this.createEnvelope("session.join_approved", payload, session.id),
      );
    }

    logger.info({ sessionId: session.id }, "Sent multiplayer approval notification");
  }

  notifyJoinRejected(session: MultiplayerRemoteSessionDto): void {
    const payload = { session };
    const display = this.displayConnections.get(session.id);
    const remote = this.remoteConnections.get(session.id);

    if (display) {
      this.send(
        display,
        this.createEnvelope("session.join_rejected", payload, session.id),
      );
    }

    if (remote) {
      this.send(
        remote,
        this.createEnvelope("session.join_rejected", payload, session.id),
      );
    }

    logger.info({ sessionId: session.id }, "Sent multiplayer rejection notification");
  }

  notifySessionClosed(sessionId: number, reason: string): void {
    const payload = { reason };
    const display = this.displayConnections.get(sessionId);
    const remote = this.remoteConnections.get(sessionId);

    if (display) {
      this.send(display, this.createEnvelope("session.closed", payload, sessionId));
      display.close(1000, reason.slice(0, 120));
    }

    if (remote) {
      this.send(remote, this.createEnvelope("session.closed", payload, sessionId));
      remote.close(1000, reason.slice(0, 120));
    }

    logger.info({ sessionId, reason }, "Sent multiplayer session close notification");
  }

  register(fastify: FastifyInstance): void {
    fastify.get(
      "/ws",
      {
        websocket: true,
        preHandler: optionalAuth,
        schema: {
          tags: ["multiplayer-remote"],
          summary: "Open multiplayer remote websocket",
          description:
            "Dedicated authenticated websocket transport for display and remote clients.",
        },
      },
      (socket, request) => {
        socket.once("message", (data: Buffer | string) => {
          this.handleHello(
            socket,
            request.user?.id ?? null,
            typeof request.headers["user-agent"] === "string"
              ? request.headers["user-agent"]
              : null,
            data,
          ).catch((error) => {
            this.sendErrorAndClose(socket, error);
          });
        });

        socket.on("error", (error: Error) => {
          logger.warn({ error }, "Multiplayer websocket error before binding");
        });
      },
    );
  }

  private async handleHello(
    socket: WebSocket,
    authenticatedUserId: number | null,
    userAgent: string | null,
    data: Buffer | string,
  ): Promise<void> {
    const raw = this.parseJsonObject(data);
    this.assertProtocolVersion(raw);

    const parsed = clientHelloEventSchema.parse(raw);
    const { sessionId, role, clientInfo } = parsed.payload;
    const clientId = clientInfo?.clientId ?? randomUUID();
    const displayDeviceAuth = parsed.payload.displayDeviceAuth;

    const isDisplayDeviceReconnect = role === "display" && Boolean(displayDeviceAuth);

    const session = isDisplayDeviceReconnect
      ? await multiplayerRemoteService.bindDisplayDeviceClient({
          deviceId: displayDeviceAuth!.deviceId,
          deviceSecret: displayDeviceAuth!.deviceSecret,
          clientId,
          deviceName: clientInfo?.deviceName,
          deviceType: clientInfo?.deviceType,
          userAgent,
        })
      : await this.bindAuthenticatedClient({
          authenticatedUserId,
          sessionId,
          role,
          clientId,
        });

    if (isDisplayDeviceReconnect) {
      // The same persistent display reconnecting (e.g. after a page refresh) reclaims
      // its own display slot; evict any stale socket the backend has not torn down yet.
      this.evictExistingConnection(session.id, role);
    } else {
      this.assertSingleConnection(session.id, role);
    }

    const heartbeatInterval = setInterval(() => {
      this.send(socket, {
        event: "client.connected",
        payload: { heartbeat: true },
        timestamp: new Date().toISOString(),
        protocolVersion: multiplayerRemoteProtocolVersion,
        sessionId: session.id,
      });
      void multiplayerRemoteService.heartbeatConnection({
        sessionId: session.id,
        role,
      }).catch((error) => {
        logger.warn(
          { error, sessionId: session.id, role },
          "Failed to persist multiplayer heartbeat",
        );
      });
    }, HEARTBEAT_INTERVAL_MS);

    const bound: BoundConnection = {
      socket,
      sessionId: session.id,
      userId: session.ownerUserId,
      role,
      clientId,
      heartbeatInterval,
    };

    this.connections.set(socket, bound);
    if (role === "display") {
      this.displayConnections.set(session.id, socket);
    } else {
      this.remoteConnections.set(session.id, socket);
    }

    this.send(socket, {
      event: "client.connected",
      payload: {
        role,
        clientId,
        session,
      },
      timestamp: new Date().toISOString(),
      protocolVersion: multiplayerRemoteProtocolVersion,
      sessionId: session.id,
    });

    if (role === "remote" && session.lastState) {
      this.send(socket, {
        event: "session.state",
        payload: session.lastState,
        timestamp: new Date().toISOString(),
        protocolVersion: multiplayerRemoteProtocolVersion,
        sessionId: session.id,
      });
    }

    socket.on("message", (message: Buffer | string) => {
      this.handleMessage(socket, message).catch((error) => {
        logger.warn(
          { error, sessionId: session.id, role },
          "Multiplayer websocket message rejected",
        );
        this.send(socket, {
          event: "command.rejected",
          payload: {
            message: error instanceof Error ? error.message : "Invalid message",
          },
          timestamp: new Date().toISOString(),
          protocolVersion: multiplayerRemoteProtocolVersion,
          sessionId: session.id,
        });
      });
    });

    socket.on("close", () => {
      this.cleanup(socket).catch((error) => {
        logger.warn(
          { error, sessionId: session.id, role },
          "Failed to clean up websocket",
        );
      });
    });

    socket.on("error", (error: Error) => {
      logger.warn({ error, sessionId: session.id, role }, "Multiplayer websocket error");
    });

    logger.info(
      { sessionId: session.id, userId: session.ownerUserId, role },
      "Multiplayer websocket connected",
    );
  }

  private async bindAuthenticatedClient(params: {
    authenticatedUserId: number | null;
    sessionId?: number;
    role: MultiplayerRemoteClientRole;
    clientId: string;
  }): Promise<MultiplayerRemoteSessionDto> {
    if (!params.authenticatedUserId) {
      throw new UnauthorizedError("Authentication is required for this websocket");
    }

    if (!params.sessionId) {
      throw new Error("sessionId is required for authenticated websocket clients");
    }

    return multiplayerRemoteService.bindClient({
      sessionId: params.sessionId,
      userId: params.authenticatedUserId,
      role: params.role,
      clientId: params.clientId,
    });
  }

  private async handleMessage(
    socket: WebSocket,
    message: Buffer | string,
  ): Promise<void> {
    const connection = this.connections.get(socket);
    if (!connection) {
      throw new Error("Connection has not completed client.hello");
    }

    const raw = this.parseJsonObject(message);
    this.assertProtocolVersion(raw);
    const envelope = websocketEventEnvelopeSchema.parse(raw);

    if (envelope.event === "client.hello") {
      throw new Error("client.hello has already been received");
    }

    if (envelope.sessionId && envelope.sessionId !== connection.sessionId) {
      throw new Error("Message sessionId does not match connection");
    }

    if (envelope.event === "session.state") {
      await this.handleSessionState(socket, message, connection);
      return;
    }

    if (envelope.event === "playback.state") {
      await this.handlePlaybackState(socket, message, connection);
      return;
    }

    if (envelope.event === "command.request") {
      await this.handleCommandRequest(socket, message, connection);
      return;
    }

    if (envelope.event === "command.ack") {
      await this.forwardDisplayCommandResult(socket, message, connection, "ack");
      return;
    }

    if (envelope.event === "command.failed") {
      await this.forwardDisplayCommandResult(socket, message, connection, "failed");
      return;
    }

    throw new Error(`Unsupported websocket event: ${envelope.event}`);
  }

  private async handleSessionState(
    socket: WebSocket,
    message: Buffer | string,
    connection: BoundConnection,
  ): Promise<void> {
    if (connection.role !== "display") {
      this.sendCommandRejected(socket, connection.sessionId, {
        message: "Only the display can publish session state",
      });
      return;
    }

    const event = sessionStateEventSchema.parse(this.parseJsonObject(message));
    const session = await multiplayerRemoteService.updateSessionState({
      sessionId: connection.sessionId,
      userId: connection.userId,
      clientId: connection.clientId,
      snapshot: event.payload,
    });

    const remote = this.remoteConnections.get(connection.sessionId);
    if (remote) {
      this.send(remote, {
        ...event,
        sessionId: connection.sessionId,
        payload: session.lastState ?? event.payload,
      });
    }

    logger.debug(
      { sessionId: connection.sessionId, remoteConnected: Boolean(remote) },
      "Persisted multiplayer session state",
    );
  }

  private async handlePlaybackState(
    socket: WebSocket,
    message: Buffer | string,
    connection: BoundConnection,
  ): Promise<void> {
    if (connection.role !== "display") {
      this.sendCommandRejected(socket, connection.sessionId, {
        message: "Only the display can publish playback state",
      });
      return;
    }

    await multiplayerRemoteService.getBoundSession(connection);

    const event = playbackStateEventSchema.parse(this.parseJsonObject(message));
    const remote = this.remoteConnections.get(connection.sessionId);
    if (!remote) {
      return;
    }

    this.send(remote, {
      ...event,
      sessionId: connection.sessionId,
      timestamp: new Date().toISOString(),
    });

    logger.debug(
      {
        sessionId: connection.sessionId,
        slotId: event.payload.slotId,
        currentTimestampSeconds: event.payload.currentTimestampSeconds,
      },
      "Forwarded multiplayer playback state to remote",
    );
  }

  private async handleCommandRequest(
    socket: WebSocket,
    message: Buffer | string,
    connection: BoundConnection,
  ): Promise<void> {
    const event = commandRequestEventSchema.parse(this.parseJsonObject(message));

    if (connection.role !== "remote") {
      this.sendCommandRejected(socket, connection.sessionId, {
        commandId: event.commandId,
        message: "Only the remote can send command requests",
      });
      return;
    }

    const session = await multiplayerRemoteService.getBoundSession(connection);
    if (session.status !== "active" || !session.approvedAt) {
      this.sendCommandRejected(socket, connection.sessionId, {
        commandId: event.commandId,
        message: "Remote has not been approved for this session",
      });
      return;
    }

    const display = this.displayConnections.get(connection.sessionId);
    if (!display) {
      this.sendCommandRejected(socket, connection.sessionId, {
        commandId: event.commandId,
        message: "Display is not connected",
      });
      return;
    }

    this.send(display, {
      ...event,
      sessionId: connection.sessionId,
      timestamp: new Date().toISOString(),
    });

    logger.debug(
      {
        sessionId: connection.sessionId,
        commandId: event.commandId,
        commandType: event.payload.type,
      },
      "Forwarded multiplayer command to display",
    );
  }

  private async forwardDisplayCommandResult(
    socket: WebSocket,
    message: Buffer | string,
    connection: BoundConnection,
    resultType: "ack" | "failed",
  ): Promise<void> {
    if (connection.role !== "display") {
      this.sendCommandRejected(socket, connection.sessionId, {
        message: "Only the display can send command results",
      });
      return;
    }

    await multiplayerRemoteService.getBoundSession(connection);

    const event =
      resultType === "ack"
        ? commandAckEventSchema.parse(this.parseJsonObject(message))
        : commandFailedEventSchema.parse(this.parseJsonObject(message));

    const remote = this.remoteConnections.get(connection.sessionId);
    if (!remote) {
      return;
    }

    this.send(remote, {
      ...event,
      sessionId: connection.sessionId,
      timestamp: new Date().toISOString(),
    });

    logger.debug(
      {
        sessionId: connection.sessionId,
        commandId: event.commandId,
        resultType,
      },
      "Forwarded multiplayer command result to remote",
    );
  }

  private assertSingleConnection(
    sessionId: number,
    role: MultiplayerRemoteClientRole,
  ): void {
    const existing =
      role === "display"
        ? this.displayConnections.get(sessionId)
        : this.remoteConnections.get(sessionId);

    if (existing && existing.readyState === WEBSOCKET_OPEN_STATE) {
      throw new Error(`Session already has an active ${role} connection`);
    }
  }

  private evictExistingConnection(
    sessionId: number,
    role: MultiplayerRemoteClientRole,
  ): void {
    const existing =
      role === "display"
        ? this.displayConnections.get(sessionId)
        : this.remoteConnections.get(sessionId);

    if (!existing) {
      return;
    }

    // Detach the stale socket from all bookkeeping first so its close handler
    // becomes a no-op (it can no longer find a bound connection) and cannot
    // close the session that the new connection is taking over.
    const bound = this.connections.get(existing);
    if (bound) {
      clearInterval(bound.heartbeatInterval);
      this.connections.delete(existing);
    }

    if (role === "display") {
      this.displayConnections.delete(sessionId);
    } else {
      this.remoteConnections.delete(sessionId);
    }

    try {
      existing.close(1000, "Replaced by a new connection");
    } catch {
      // best-effort
    }

    logger.info(
      { sessionId, role },
      "Evicted stale multiplayer connection for reconnecting client",
    );
  }

  private async cleanup(socket: WebSocket): Promise<void> {
    const connection = this.connections.get(socket);
    if (!connection) {
      return;
    }

    clearInterval(connection.heartbeatInterval);
    this.connections.delete(socket);

    if (connection.role === "display") {
      this.displayConnections.delete(connection.sessionId);
    } else {
      this.remoteConnections.delete(connection.sessionId);
    }

    const wasClosed = await multiplayerRemoteService.isSessionClosed(
      connection.sessionId,
    );

    const didClose = await multiplayerRemoteService.disconnectClient(connection);

    if (connection.role === "display" && !wasClosed && didClose) {
      this.notifySessionClosed(connection.sessionId, "display_disconnected");
    }

    logger.info(
      {
        sessionId: connection.sessionId,
        userId: connection.userId,
        role: connection.role,
      },
      "Multiplayer websocket disconnected",
    );
  }

  private send(
    socket: WebSocket,
    envelope: MultiplayerRemoteEventEnvelope,
  ): void {
    if (socket.readyState !== WEBSOCKET_OPEN_STATE) {
      return;
    }

    socket.send(JSON.stringify(envelope));
  }

  private parseJsonObject(message: Buffer | string): Record<string, unknown> {
    const parsed: unknown = JSON.parse(message.toString());

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Websocket message must be a JSON object");
    }

    return parsed as Record<string, unknown>;
  }

  private assertProtocolVersion(message: Record<string, unknown>): void {
    const protocolVersion = message.protocolVersion;

    if (protocolVersion !== multiplayerRemoteProtocolVersion) {
      throw new Error(
        `Unsupported multiplayer remote protocol version: expected ${multiplayerRemoteProtocolVersion}`,
      );
    }

    if (message.event !== "client.hello") {
      return;
    }

    const payload = message.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return;
    }

    const helloProtocolVersion = (
      payload as { protocolVersion?: unknown }
    ).protocolVersion;
    if (helloProtocolVersion !== multiplayerRemoteProtocolVersion) {
      throw new Error(
        `Unsupported multiplayer remote hello protocol version: expected ${multiplayerRemoteProtocolVersion}`,
      );
    }
  }

  private sendCommandRejected(
    socket: WebSocket,
    sessionId: number,
    input: {
      message: string;
      commandId?: string;
    },
  ): void {
    this.send(socket, {
      event: "command.rejected",
      payload: { message: input.message },
      timestamp: new Date().toISOString(),
      protocolVersion: multiplayerRemoteProtocolVersion,
      sessionId,
      commandId: input.commandId,
    });
  }

  private createEnvelope<TPayload>(
    event: MultiplayerRemoteEventEnvelope<TPayload>["event"],
    payload: TPayload,
    sessionId: number,
  ): MultiplayerRemoteEventEnvelope<TPayload> {
    return {
      event,
      payload,
      timestamp: new Date().toISOString(),
      protocolVersion: multiplayerRemoteProtocolVersion,
      sessionId,
    };
  }

  private sendErrorAndClose(socket: WebSocket, error: unknown): void {
    const message =
      error instanceof Error ? error.message : "Failed to initialize websocket";

    try {
      this.send(socket, {
        event: "command.rejected",
        payload: { message },
        timestamp: new Date().toISOString(),
        protocolVersion: multiplayerRemoteProtocolVersion,
      });
    } finally {
      socket.close(1008, message.slice(0, 120));
    }
  }
}

export const multiplayerRemoteWebSocketService =
  new MultiplayerRemoteWebSocketService();
