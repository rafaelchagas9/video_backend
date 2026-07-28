import type { FastifyReply, FastifyRequest } from "fastify";
import { authService } from "./auth.service";
import type { AuthSessionData, AuthUser } from "./auth.types";
import { UnauthorizedError } from "@/utils/errors";
import { env } from "@/config/env";

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthUser;
    authSession?: AuthSessionData;
  }
}

export async function authenticateUser(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  if (env.DEMO_MODE) {
    const session = authService.getDemoSession();
    request.user = session.user;
    request.authSession = session;
    return;
  }

  const session = await authService.getSession(request.headers);

  if (!session) {
    throw new UnauthorizedError("No valid session found. Please log in.");
  }

  request.user = session.user;
  request.authSession = session;
}

export async function optionalAuth(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  if (env.DEMO_MODE) {
    const session = authService.getDemoSession();
    request.user = session.user;
    request.authSession = session;
    return;
  }

  const session = await authService.getSession(request.headers);

  if (!session) {
    return;
  }

  request.user = session.user;
  request.authSession = session;
}
