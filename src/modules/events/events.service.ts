import { randomUUID } from "crypto";
import type { ServerResponse } from "http";
import { authService } from "@/modules/auth/auth.service";
import { logger } from "@/utils/logger";

export interface RealtimeEvent {
  type: string;
  message: unknown;
  timestamp?: string;
}

interface SseClient {
  id: string;
  response: ServerResponse;
  userId: number;
  sessionToken: string;
  connectedAt: Date;
  keepaliveInterval: ReturnType<typeof setInterval>;
  sessionValidationInterval: ReturnType<typeof setInterval>;
}

const KEEPALIVE_INTERVAL_MS = 20_000;
const SESSION_VALIDATION_INTERVAL_MS = 30_000;

class EventsService {
  private clients: Map<string, SseClient> = new Map();

  addAuthenticatedClient(params: {
    response: ServerResponse;
    userId: number;
    sessionToken: string;
  }): void {
    const clientId = randomUUID();
    const { response, userId, sessionToken } = params;

    const keepaliveInterval = setInterval(() => {
      this.sendComment(clientId, "keepalive");
    }, KEEPALIVE_INTERVAL_MS);

    const sessionValidationInterval = setInterval(() => {
      this.validateClientSession(clientId).catch((error: unknown) => {
        logger.warn({ error, clientId }, "Failed to validate SSE session");
      });
    }, SESSION_VALIDATION_INTERVAL_MS);

    const client: SseClient = {
      id: clientId,
      response,
      userId,
      sessionToken,
      connectedAt: new Date(),
      keepaliveInterval,
      sessionValidationInterval,
    };

    this.clients.set(clientId, client);

    this.sendComment(clientId, "connected");

    const cleanup = () => {
      this.removeClient(clientId, "disconnected");
    };

    response.on("close", cleanup);
    response.on("error", () => cleanup());

    logger.info(
      { userId, totalClients: this.clients.size },
      "SSE client connected"
    );
  }

  broadcast(event: RealtimeEvent): void {
    for (const client of this.clients.values()) {
      this.sendEventToClient(client, event);
    }

    logger.debug(
      { type: event.type, sentTo: this.clients.size },
      "SSE broadcast sent"
    );
  }

  broadcastToAuthenticated(event: RealtimeEvent): void {
    this.broadcast(event);
  }

  broadcastToUser(userId: number, event: RealtimeEvent): void {
    let sentTo = 0;
    for (const client of this.clients.values()) {
      if (client.userId !== userId) continue;
      this.sendEventToClient(client, event);
      sentTo += 1;
    }
    logger.debug(
      { type: event.type, userId, sentTo },
      "User-scoped SSE broadcast sent"
    );
  }

  getStats(): { totalConnections: number; authenticatedConnections: number } {
    return {
      totalConnections: this.clients.size,
      authenticatedConnections: this.clients.size,
    };
  }

  closeAll(reason: string): void {
    for (const clientId of Array.from(this.clients.keys())) {
      this.removeClient(clientId, reason);
    }
  }

  private async validateClientSession(clientId: string): Promise<void> {
    const client = this.clients.get(clientId);
    if (!client) return;

    const isValid = await authService.validateSessionToken(client.sessionToken);
    if (isValid) return;

    this.sendEventToClient(client, {
      type: "auth:expired",
      message: { message: "Session expired" },
    });
    this.removeClient(clientId, "session expired");
  }

  private sendComment(clientId: string, comment: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    try {
      if (!client.response.writableEnded) {
        client.response.write(`: ${comment}\n\n`);
      }
    } catch (error) {
      logger.warn({ error, clientId }, "Failed to write SSE comment");
      this.removeClient(clientId, "write failure");
    }
  }

  private sendEventToClient(client: SseClient, event: RealtimeEvent): void {
    try {
      if (client.response.writableEnded) {
        this.removeClient(client.id, "stream ended");
        return;
      }

      const payload = {
        type: event.type,
        message: event.message,
        timestamp: event.timestamp ?? new Date().toISOString(),
      };

      const frame = `event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`;
      client.response.write(frame);
    } catch (error) {
      logger.warn(
        { error, clientId: client.id },
        "Failed to write SSE event frame"
      );
      this.removeClient(client.id, "write failure");
    }
  }

  private removeClient(clientId: string, reason: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    clearInterval(client.keepaliveInterval);
    clearInterval(client.sessionValidationInterval);

    this.clients.delete(clientId);

    if (!client.response.writableEnded) {
      client.response.end();
    }

    logger.info(
      {
        clientId,
        userId: client.userId,
        reason,
        totalClients: this.clients.size,
      },
      "SSE client disconnected"
    );
  }
}

export const eventsService = new EventsService();
