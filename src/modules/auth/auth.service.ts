import { fromNodeHeaders } from "better-auth/node";
import { isAPIError } from "better-auth/api";
import type { IncomingHttpHeaders } from "http";
import { db } from "@/config/drizzle";
import { AppError, UnauthorizedError } from "@/utils/errors";
import type {
  AuthSession,
  AuthSessionData,
  AuthUser,
  LoginInput,
  RegisterInput,
} from "./auth.types";
import { env } from "@/config/env";

const DEMO_TIMESTAMP = "2026-01-01T00:00:00.000Z";
const DEMO_USER: AuthUser = {
  id: 1,
  name: "Demo User",
  email: "demo@example.invalid",
  email_verified: true,
  image: null,
  username: "demo",
  created_at: DEMO_TIMESTAMP,
  updated_at: DEMO_TIMESTAMP,
};

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
  message?: string;
};

function toHeaders(headers: IncomingHttpHeaders | Headers): Headers {
  return headers instanceof Headers ? headers : fromNodeHeaders(headers);
}

function toIsoString(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
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
    throw new AppError(error.statusCode, error.message);
  }

  throw error;
}

export class AuthService {
  getDemoSession(): AuthSessionData {
    return {
      user: { ...DEMO_USER },
      session: {
        id: "demo-session",
        token: "demo-session",
        user_id: DEMO_USER.id,
        expires_at: "2099-01-01T00:00:00.000Z",
        created_at: DEMO_TIMESTAMP,
        updated_at: DEMO_TIMESTAMP,
        ip_address: null,
        user_agent: "demo-mode",
      },
    };
  }

  private createDemoResponse(status = 200): Response {
    return new Response(JSON.stringify({ user: DEMO_USER }), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

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

  private async assertAuthResponse(response: Response): Promise<void> {
    if (response.ok) return;
    const payload = (await response
      .clone()
      .json()
      .catch(() => null)) as BetterAuthAuthResponse | null;
    throw new AppError(
      response.status,
      payload?.message || "Authentication failed"
    );
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
    headers: IncomingHttpHeaders | Headers
  ): Promise<{ user: AuthUser; response: Response }> {
    if (env.DEMO_MODE) {
      return {
        user: { ...DEMO_USER },
        response: this.createDemoResponse(201),
      };
    }

    try {
      const { withOwnerRegistration } = await import("@/lib/auth");
      const response = await withOwnerRegistration(async (registrationAuth) => {
        const result = await registrationAuth.api.signUpEmail({
          asResponse: true,
          headers: toHeaders(headers),
          body: {
            email: input.email,
            password: input.password,
            name: input.name?.trim() || getFallbackName(input.email),
          },
        });
        // Throw before transaction commit so failed credential creation cannot
        // leave an unusable owner account that permanently closes registration.
        await this.assertAuthResponse(result);
        return result;
      });

      await this.assertAuthResponse(response);
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
    headers: IncomingHttpHeaders | Headers
  ): Promise<{ user: AuthUser; response: Response }> {
    if (env.DEMO_MODE) {
      return {
        user: { ...DEMO_USER },
        response: this.createDemoResponse(),
      };
    }

    try {
      const email = await this.resolveLoginEmail(input);
      const { auth } = await import("@/lib/auth");
      const response = await auth.api.signInEmail({
        asResponse: true,
        headers: toHeaders(headers),
        body: {
          email,
          password: input.password,
        },
      });

      await this.assertAuthResponse(response);
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
    if (env.DEMO_MODE) {
      return new Response(null, { status: 200 });
    }

    try {
      const { auth } = await import("@/lib/auth");
      return await auth.api.signOut({
        asResponse: true,
        headers: toHeaders(headers),
      });
    } catch (error) {
      mapBetterAuthError(error);
    }
  }

  async getSession(
    headers: IncomingHttpHeaders | Headers
  ): Promise<AuthSessionData | null> {
    if (env.DEMO_MODE) {
      return this.getDemoSession();
    }

    try {
      const { auth } = await import("@/lib/auth");
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
    if (env.DEMO_MODE) {
      return token === "demo-session";
    }

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
      throw new UnauthorizedError(
        "Invalid or expired session. Please log in again."
      );
    }

    return session.user;
  }
}

export const authService = new AuthService();
