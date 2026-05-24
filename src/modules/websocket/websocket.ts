/**
 * WebSocket service for real-time event broadcasting
 */
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import { logger } from "@/utils/logger";
import { db } from "@/config/drizzle";
import { videoStatsService } from "@/modules/video-stats/video-stats.service";

interface ClientConnection {
  socket: WebSocket;
  userId: number | null;
  connectedAt: Date;
}

interface WatchSession {
  videoId: number;
  watchedSecondsAccum: number;
  lastPositionSeconds?: number;
  lastRecordedAt: number;
}

class WebSocketService {
  private clients: Map<WebSocket, ClientConnection> = new Map();
  private watchSessions: Map<WebSocket, Map<number, WatchSession>> = new Map();

  /**
   * Initialize WebSocket with Fastify instance
   */
  async register(fastify: FastifyInstance): Promise<void> {
    // Register WebSocket route
    fastify.get("/ws", { websocket: true }, async (socket, request) => {
      // Try to get user from session cookie
      const userId = await this.getUserFromRequest(request);

      const connection: ClientConnection = {
        socket,
        userId,
        connectedAt: new Date(),
      };

      this.clients.set(socket, connection);
      this.watchSessions.set(socket, new Map());
      logger.info(
        { userId, totalClients: this.clients.size },
        "WebSocket client connected",
      );

      // Send welcome message
      this.sendToSocket(socket, {
        type: "connected",
        message: "WebSocket connection established",
        timestamp: new Date().toISOString(),
      });

      socket.on("message", (data: Buffer | string) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleMessage(socket, message).catch((error: unknown) => {
            logger.error({ error }, "Failed to handle WebSocket message");
          });
        } catch {
          logger.debug("Received non-JSON WebSocket message");
        }
      });

      socket.on("close", () => {
        this.flushWatchSessions(socket).catch((error) => {
          logger.error({ error }, "Failed to flush watch sessions on close");
        });
        this.clients.delete(socket);
        this.watchSessions.delete(socket);
        logger.info(
          { userId, totalClients: this.clients.size },
          "WebSocket client disconnected",
        );
      });

      socket.on("error", (error: Error) => {
        logger.error({ error }, "WebSocket error");
        this.clients.delete(socket);
      });
    });

    logger.info("WebSocket service registered at /ws");
  }

  /**
   * Extract user ID from session cookie
   */
  private async getUserFromRequest(request: any): Promise<number | null> {
    try {
      const sessionId = request.cookies?.session_id;
      if (!sessionId) return null;

      const session = await db.query.sessionsTable.findFirst({
        where: (sessions, { eq, and, gt }) =>
          and(eq(sessions.id, sessionId), gt(sessions.expiresAt, new Date())),
        columns: { userId: true },
      });

      return session?.userId ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Flush in-memory buffered watch sessions to the database
   */
  private async flushWatchSessions(socket: WebSocket, specificVideoId?: number): Promise<void> {
    const clientSessions = this.watchSessions.get(socket);
    if (!clientSessions) return;

    const connection = this.clients.get(socket);
    if (!connection?.userId) return;

    const flushVideo = async (videoId: number, session: WatchSession) => {
      if (session.watchedSecondsAccum > 0) {
        try {
          await videoStatsService.recordWatch(connection.userId!, videoId, {
            watched_seconds: session.watchedSecondsAccum,
            last_position_seconds: session.lastPositionSeconds,
          });
          session.watchedSecondsAccum = 0;
        } catch (error) {
          logger.error({ error, videoId }, "Failed to record buffered watch stats");
        }
      }
    };

    if (specificVideoId !== undefined) {
      const session = clientSessions.get(specificVideoId);
      if (session) {
        await flushVideo(specificVideoId, session);
        clientSessions.delete(specificVideoId);
      }
    } else {
      const promises = Array.from(clientSessions.entries()).map(([videoId, session]) =>
        flushVideo(videoId, session)
      );
      await Promise.all(promises);
      clientSessions.clear();
    }
  }

  /**
   * Handle incoming WebSocket messages
   */
  private async handleMessage(socket: WebSocket, message: any): Promise<void> {
    // Ping/pong for keep-alive
    if (message?.type === "ping") {
      this.sendToSocket(socket, {
        type: "pong",
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (message?.type === "video:watch") {
      const connection = this.clients.get(socket);
      if (!connection?.userId) return;

      const payload = message.payload ?? {};
      const videoId = Number(payload.video_id);
      const watchedSeconds = Number(payload.watched_seconds);
      const lastPositionRaw = payload.last_position_seconds;
      const lastPositionSeconds =
        lastPositionRaw === undefined ? undefined : Number(lastPositionRaw);

      if (!Number.isFinite(videoId) || videoId <= 0) return;
      if (!Number.isFinite(watchedSeconds) || watchedSeconds <= 0) return;
      if (
        lastPositionSeconds !== undefined &&
        !Number.isFinite(lastPositionSeconds)
      )
        return;

      let clientSessions = this.watchSessions.get(socket);
      if (!clientSessions) {
        clientSessions = new Map();
        this.watchSessions.set(socket, clientSessions);
      }

      // If switching videos, flush the old video stats first
      for (const [activeVideoId] of clientSessions) {
        if (activeVideoId !== videoId) {
          await this.flushWatchSessions(socket, activeVideoId);
        }
      }

      let session = clientSessions.get(videoId);
      const now = Date.now();
      if (!session) {
        session = {
          videoId,
          watchedSecondsAccum: watchedSeconds,
          lastPositionSeconds,
          lastRecordedAt: now,
        };
        clientSessions.set(videoId, session);
      } else {
        session.watchedSecondsAccum += watchedSeconds;
        session.lastPositionSeconds = lastPositionSeconds;
      }

      // Flush if 5 seconds have elapsed since last recorded time
      if (now - session.lastRecordedAt >= 5000) {
        await this.flushWatchSessions(socket, videoId);
        clientSessions.set(videoId, {
          videoId,
          watchedSecondsAccum: 0,
          lastPositionSeconds,
          lastRecordedAt: now,
        });
      }
    }
  }

  /**
   * Send message to a specific socket
   */
  private sendToSocket(socket: WebSocket, data: any): void {
    try {
      if (socket.readyState === 1) {
        // WebSocket.OPEN
        socket.send(JSON.stringify(data));
      }
    } catch (error) {
      logger.error({ error }, "Failed to send WebSocket message");
    }
  }

  /**
   * Broadcast message to all connected clients
   */
  broadcast(data: any): void {
    const message = JSON.stringify(data);
    let sent = 0;

    for (const [socket] of this.clients) {
      try {
        if (socket.readyState === 1) {
          // WebSocket.OPEN
          socket.send(message);
          sent++;
        }
      } catch (error) {
        logger.error({ error }, "Failed to broadcast to client");
      }
    }

    logger.debug({ type: data.type, sentTo: sent }, "Broadcast sent");
  }

  /**
   * Broadcast to authenticated users only
   */
  broadcastToAuthenticated(data: any): void {
    const message = JSON.stringify(data);
    let sent = 0;

    for (const [socket, connection] of this.clients) {
      if (connection.userId !== null) {
        try {
          if (socket.readyState === 1) {
            socket.send(message);
            sent++;
          }
        } catch (error) {
          logger.error({ error }, "Failed to broadcast to client");
        }
      }
    }

    logger.debug(
      { type: data.type, sentTo: sent },
      "Authenticated broadcast sent",
    );
  }

  /**
   * Get connection stats
   */
  getStats(): { totalConnections: number; authenticatedConnections: number } {
    let authenticated = 0;
    for (const connection of this.clients.values()) {
      if (connection.userId !== null) {
        authenticated++;
      }
    }

    return {
      totalConnections: this.clients.size,
      authenticatedConnections: authenticated,
    };
  }
}

export const websocketService = new WebSocketService();
