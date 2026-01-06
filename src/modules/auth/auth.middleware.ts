import type { FastifyRequest, FastifyReply } from 'fastify';
import { UnauthorizedError } from '@/utils/errors';
import { authService } from './auth.service';
import { COOKIE_NAME } from '@/config/constants';
import type { User } from './auth.types';

declare module 'fastify' {
  interface FastifyRequest {
    user?: User;
  }
}

export async function authenticateUser(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const sessionId = request.cookies[COOKIE_NAME];

  if (!sessionId) {
    throw new UnauthorizedError('No session found. Please log in.');
  }

  const user = await authService.validateSession(sessionId);

  if (!user) {
    reply.clearCookie(COOKIE_NAME);
    throw new UnauthorizedError('Invalid or expired session. Please log in again.');
  }

  request.user = user;
}

export async function optionalAuth(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const sessionId = request.cookies[COOKIE_NAME];

  if (sessionId) {
    const user = await authService.validateSession(sessionId);
    if (user) {
      request.user = user;
    } else {
      reply.clearCookie(COOKIE_NAME);
    }
  }
}
