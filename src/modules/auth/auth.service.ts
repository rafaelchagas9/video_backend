import { fromNodeHeaders } from "better-auth/node";
import { isAPIError } from "better-auth/api";
import type { IncomingHttpHeaders } from "http";
import { db } from "@/config/drizzle";
import { auth } from "@/lib/auth";
import { AppError, UnauthorizedError } from "@/utils/errors";
import type {
  AuthSession,
  AuthSessionData,
  AuthUser,
  LoginInput,
  RegisterInput,
} from "./auth.types";

type BetterAuthUser = {
  id: string | number;
  email: string;
  emailVerified: boolean;
  name: string;
  image?: string | null;
  username?: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

type BetterAuthSession = {
  id: string | number;
  token: string;
  userId: string | number;
  expiresAt: Date | string;
  createdAt: Date | string;
  updatedAt: Date | string;
  ipAddress?: string | null;
  userAgent?: string | null;
};

type BetterAuthSessionPayload = {
  user: BetterAuthUser;
  session: BetterAuthSession;
};

type BetterAuthAuthResponse = {
  user?: BetterAuthUser;
  token?: string | null;
};

function toHeaders(headers: IncomingHttpHeaders | Headers): Headers {
  return headers instanceof Headers ? headers : fromNodeHeaders(headers);
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toNumericUserId(value: string | number): number {
  const userId = typeof value === "number" ? value : Number(value);

  if (!Number.isInteger(userId) || userId <= 0) {
    throw new UnauthorizedError("Invalid authenticated user identifier");
  }

  return userId;
}

function getFallbackName(email: string): string {
  const fallback = email.split("@")[0]?.trim();
  return fallback && fallback.length > 0 ? fallback : email;
}

function mapBetterAuthError(error: unknown): never {
  if (isAPIError(error)) {
    throw new AppError(Number(error.status), error.message);
  }

  throw error;
}

export class AuthService {
  private async resolveLoginEmail(input: LoginInput): Promise<string> {
    if (input.email) {
      return input.email;
    }

    const username = input.username?.trim();
    if (!username) {
      throw new UnauthorizedError("Email or username is required");
    }

    const user = await db.query.usersTable.findFirst({
      where: (users, { eq }) => eq(users.username, username),
      columns: {
        email: true,
      },
    });

    if (!user?.email) {
      throw new UnauthorizedError("Invalid credentials");
    }

    return user.email;
  }

  private normalizeUser(user: BetterAuthUser): AuthUser {
    return {
      id: toNumericUserId(user.id),
      name: user.name,
      email: user.email,
      email_verified: user.emailVerified,
      image: user.image ?? null,
      username: user.username ?? null,
      created_at: toIsoString(user.createdAt),
      updated_at: toIsoString(user.updatedAt),
    };
  }

  private normalizeSession(session: BetterAuthSession): AuthSession {
    return {
      id: String(session.id),
      token: session.token,
      user_id: toNumericUserId(session.userId),
      expires_at: toIsoString(session.expiresAt),
      created_at: toIsoString(session.createdAt),
      updated_at: toIsoString(session.updatedAt),
      ip_address: session.ipAddress ?? null,
      user_agent: session.userAgent ?? null,
    };
  }

  async register(
    input: RegisterInput,
    headers: IncomingHttpHeaders | Headers,
  ): Promise<{ user: AuthUser; response: Response }> {
    try {
      const response = await auth.api.signUpEmail({
        asResponse: true,
        headers: toHeaders(headers),
        body: {
          email: input.email,
          password: input.password,
          name: input.name?.trim() || getFallbackName(input.email),
        },
      });

      const payload = (await response.clone().json()) as BetterAuthAuthResponse;

      if (!payload.user) {
        throw new Error("Better Auth did not return a registered user");
      }

      return {
        user: this.normalizeUser(payload.user),
        response,
      };
    } catch (error) {
      mapBetterAuthError(error);
    }
  }

  async login(
    input: LoginInput,
    headers: IncomingHttpHeaders | Headers,
  ): Promise<{ user: AuthUser; response: Response }> {
    try {
      const email = await this.resolveLoginEmail(input);
      const response = await auth.api.signInEmail({
        asResponse: true,
        headers: toHeaders(headers),
        body: {
          email,
          password: input.password,
        },
      });

      const payload = (await response.clone().json()) as BetterAuthAuthResponse;

      if (!payload.user) {
        throw new Error("Better Auth did not return an authenticated user");
      }

      return {
        user: this.normalizeUser(payload.user),
        response,
      };
    } catch (error) {
      mapBetterAuthError(error);
    }
  }

  async logout(headers: IncomingHttpHeaders | Headers): Promise<Response> {
    try {
      return await auth.api.signOut({
        asResponse: true,
        headers: toHeaders(headers),
      });
    } catch (error) {
      mapBetterAuthError(error);
    }
  }

  async getSession(
    headers: IncomingHttpHeaders | Headers,
  ): Promise<AuthSessionData | null> {
    try {
      const session = await auth.api.getSession({
        headers: toHeaders(headers),
      });

      if (!session) {
        return null;
      }

      const payload = session as BetterAuthSessionPayload;

      return {
        user: this.normalizeUser(payload.user),
        session: this.normalizeSession(payload.session),
      };
    } catch (error) {
      mapBetterAuthError(error);
    }
  }

  async validateSessionToken(token: string): Promise<boolean> {
    const session = await db.query.sessionsTable.findFirst({
      where: (sessions, { and, eq, gt }) =>
        and(eq(sessions.token, token), gt(sessions.expiresAt, new Date())),
      columns: {
        id: true,
      },
    });

    return Boolean(session);
  }

  async getMe(headers: IncomingHttpHeaders | Headers): Promise<AuthUser> {
    const session = await this.getSession(headers);

    if (!session) {
      throw new UnauthorizedError("Invalid or expired session. Please log in again.");
    }

    return session.user;
  }
}

export const authService = new AuthService();
