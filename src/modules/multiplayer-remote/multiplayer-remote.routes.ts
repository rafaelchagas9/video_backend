import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { authenticateUser } from "@/modules/auth/auth.middleware";
import { multiplayerRemoteService } from "./multiplayer-remote.service";
import { multiplayerRemoteWebSocketService } from "./multiplayer-remote.websocket";
import {
  closeSessionBodySchema,
  createSessionResponseSchema,
  errorResponseSchema,
  joinRequestIdParamSchema,
  messageResponseSchema,
  pairBodySchema,
  pairResponseSchema,
  pendingJoinRequestResponseSchema,
  registerDisplayDeviceBodySchema,
  registerDisplayDeviceResponseSchema,
  sessionIdParamSchema,
  sessionResponseSchema,
  trustedConnectResponseSchema,
  trustedDeviceBodySchema,
  trustedDiscoveryResponseSchema,
} from "./multiplayer-remote.schemas";

export async function multiplayerRemoteRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.addHook("preHandler", authenticateUser);

  multiplayerRemoteWebSocketService.register(fastify);

  app.post(
    "/display-devices",
    {
      schema: {
        tags: ["multiplayer-remote"],
        summary: "Register a persistent pairable display device",
        description:
          "Creates long-lived display-device credentials so the display can advertise availability without depending on the browser auth session lifetime.",
        body: registerDisplayDeviceBodySchema,
        response: {
          201: registerDisplayDeviceResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await multiplayerRemoteService.registerDisplayDevice(
        request.user!.id,
        request.body,
        typeof request.headers["user-agent"] === "string"
          ? request.headers["user-agent"]
          : null,
      );

      return reply.status(201).send({
        success: true,
        data: result,
      });
    },
  );

  app.post(
    "/sessions",
    {
      schema: {
        tags: ["multiplayer-remote"],
        summary: "Create multiplayer remote session",
        description:
          "Creates a one-time pairing session for an authenticated display client.",
        response: {
          201: createSessionResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const session = await multiplayerRemoteService.createSession(userId);

      return reply.status(201).send({
        success: true,
        data: {
          ...session,
          pairingCode: session.pairingCode!,
          pairingCodeExpiresAt: session.pairingCodeExpiresAt!,
        },
      });
    },
  );

  app.get(
    "/sessions/:id",
    {
      schema: {
        tags: ["multiplayer-remote"],
        summary: "Get multiplayer remote session",
        description:
          "Returns session metadata, connection state, latest snapshot, and pending join request if present.",
        params: sessionIdParamSchema,
        response: {
          200: sessionResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const session = await multiplayerRemoteService.getSession(
        request.params.id,
        request.user!.id,
      );

      return reply.send({
        success: true,
        data: session,
      });
    },
  );

  app.post(
    "/sessions/:id/close",
    {
      schema: {
        tags: ["multiplayer-remote"],
        summary: "Close multiplayer remote session",
        description: "Closes an active or pending multiplayer session.",
        params: sessionIdParamSchema,
        body: closeSessionBodySchema,
        response: {
          200: messageResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      await multiplayerRemoteService.closeSession(
        request.params.id,
        request.user!.id,
        request.body,
      );
      multiplayerRemoteWebSocketService.notifySessionClosed(
        request.params.id,
        request.body.reason ?? "closed_by_user",
      );

      return reply.send({
        success: true,
        message: "Multiplayer remote session closed successfully",
      });
    },
  );

  app.post(
    "/pair",
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: "1 minute",
        },
      },
      schema: {
        tags: ["multiplayer-remote"],
        summary: "Submit multiplayer pairing code",
        description:
          "Creates a pending join request for display approval using a one-time pairing code.",
        body: pairBodySchema,
        response: {
          200: pairResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await multiplayerRemoteService.pair(request.body, {
        userId: request.user!.id,
        authSessionId: request.authSession?.session.id ?? null,
        userAgent:
          typeof request.headers["user-agent"] === "string"
            ? request.headers["user-agent"]
            : null,
      });

      multiplayerRemoteWebSocketService.notifyJoinRequested(
        result.sessionId,
        result.joinRequest,
      );

      return reply.send({
        success: true,
        data: result,
      });
    },
  );

  app.post(
    "/trusted-devices/discover",
    {
      config: {
        rateLimit: {
          max: 30,
          timeWindow: "1 minute",
        },
      },
      schema: {
        tags: ["multiplayer-remote"],
        summary: "Discover display sessions for a trusted remote device",
        description:
          "Returns live display sessions that a previously approved remote device can connect to without a pairing code.",
        body: trustedDeviceBodySchema,
        response: {
          200: trustedDiscoveryResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await multiplayerRemoteService.discoverTrustedSessions(
        request.user!.id,
        request.body,
        {
          userAgent:
            typeof request.headers["user-agent"] === "string"
              ? request.headers["user-agent"]
              : null,
        },
      );

      return reply.send({
        success: true,
        data: result,
      });
    },
  );

  app.post(
    "/sessions/:id/trusted-connect",
    {
      config: {
        rateLimit: {
          max: 30,
          timeWindow: "1 minute",
        },
      },
      schema: {
        tags: ["multiplayer-remote"],
        summary: "Connect a trusted remote device",
        description:
          "Activates a live display session for a previously approved remote device without pairing code approval.",
        params: sessionIdParamSchema,
        body: trustedDeviceBodySchema,
        response: {
          200: trustedConnectResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await multiplayerRemoteService.connectTrustedDevice(
        request.params.id,
        request.user!.id,
        request.body,
        {
          userAgent:
            typeof request.headers["user-agent"] === "string"
              ? request.headers["user-agent"]
              : null,
        },
      );

      multiplayerRemoteWebSocketService.notifyJoinApproved(result.session);

      return reply.send({
        success: true,
        data: result,
      });
    },
  );

  app.get(
    "/sessions/:id/join-requests/pending",
    {
      schema: {
        tags: ["multiplayer-remote"],
        summary: "Get pending multiplayer join request",
        description:
          "Returns the current pending approval request for the display session, if any.",
        params: sessionIdParamSchema,
        response: {
          200: pendingJoinRequestResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const joinRequest =
        await multiplayerRemoteService.getPendingJoinRequestForDisplay(
          request.params.id,
          request.user!.id,
        );

      return reply.send({
        success: true,
        data: joinRequest,
      });
    },
  );

  app.post(
    "/sessions/:id/join-requests/:requestId/approve",
    {
      schema: {
        tags: ["multiplayer-remote"],
        summary: "Approve multiplayer join request",
        description:
          "Approves a pending remote join request and invalidates the pairing code.",
        params: joinRequestIdParamSchema,
        response: {
          200: sessionResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const session = await multiplayerRemoteService.approveJoinRequest(
        request.params.id,
        request.params.requestId,
        request.user!.id,
      );

      multiplayerRemoteWebSocketService.notifyJoinApproved(session);

      return reply.send({
        success: true,
        data: session,
      });
    },
  );

  app.post(
    "/sessions/:id/join-requests/:requestId/reject",
    {
      schema: {
        tags: ["multiplayer-remote"],
        summary: "Reject multiplayer join request",
        description:
          "Rejects a pending remote join request and returns the session to waiting for remote.",
        params: joinRequestIdParamSchema,
        response: {
          200: sessionResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const session = await multiplayerRemoteService.rejectJoinRequest(
        request.params.id,
        request.params.requestId,
        request.user!.id,
      );

      multiplayerRemoteWebSocketService.notifyJoinRejected(session);

      return reply.send({
        success: true,
        data: session,
      });
    },
  );
}
