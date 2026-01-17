import bcrypt from "bcrypt";
import { randomBytes } from "crypto";
import { db } from "@/config/drizzle";
import { usersTable, sessionsTable } from "@/database/schema";
import { eq, count, lte } from "drizzle-orm";
import { env } from "@/config/env";
import { ConflictError, UnauthorizedError } from "@/utils/errors";
import type {
  RegisterInput,
  LoginInput,
  User,
  AuthenticatedUser,
} from "./auth.types";

const BCRYPT_ROUNDS = 12;

export class AuthService {
  async register(input: RegisterInput): Promise<User> {
    // Check if any user already exists (single-user system)
    const userCountResult = await db
      .select({ count: count() })
      .from(usersTable);

    if (userCountResult[0].count > 0) {
      throw new ConflictError(
        "A user already exists. Registration is disabled.",
      );
    }

    // Check if username is taken (redundant but safe)
    const existingUser = await db.query.usersTable.findFirst({
      where: (users, { eq }) => eq(users.username, input.username),
      columns: { id: true },
    });

    if (existingUser) {
      throw new ConflictError("Username already exists");
    }

    // Hash password
    const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);

    // Create user
    const [result] = await db
      .insert(usersTable)
      .values({
        username: input.username,
        passwordHash,
      })
      .returning({
        id: usersTable.id,
        username: usersTable.username,
        createdAt: usersTable.createdAt,
        updatedAt: usersTable.updatedAt,
      });

    if (!result) {
      throw new Error("Failed to create user");
    }

    return {
      id: result.id,
      username: result.username,
      created_at: result.createdAt.toISOString(),
      updated_at: result.updatedAt.toISOString(),
    };
  }

  async login(input: LoginInput): Promise<AuthenticatedUser> {
    // Find user
    const [user] = await db
      .select({
        id: usersTable.id,
        username: usersTable.username,
        passwordHash: usersTable.passwordHash,
        createdAt: usersTable.createdAt,
        updatedAt: usersTable.updatedAt,
      })
      .from(usersTable)
      .where(eq(usersTable.username, input.username))
      .limit(1);

    if (!user) {
      throw new UnauthorizedError("Invalid credentials");
    }

    // Verify password
    const isValid = await bcrypt.compare(input.password, user.passwordHash);

    if (!isValid) {
      throw new UnauthorizedError("Invalid credentials");
    }

    // Create session
    const sessionId = randomBytes(32).toString("hex");
    const expiresAt = new Date(
      Date.now() + env.SESSION_EXPIRY_HOURS * 60 * 60 * 1000,
    );

    await db.insert(sessionsTable).values({
      id: sessionId,
      userId: user.id,
      expiresAt,
    });

    return {
      id: user.id,
      username: user.username,
      created_at: user.createdAt.toISOString(),
      updated_at: user.updatedAt.toISOString(),
      sessionId,
    };
  }

  async logout(sessionId: string): Promise<void> {
    await db.delete(sessionsTable).where(eq(sessionsTable.id, sessionId));
  }

  async validateSession(sessionId: string): Promise<User | null> {
    const session = await db.query.sessionsTable.findFirst({
      where: (sessions, { eq, and, gt }) =>
        and(eq(sessions.id, sessionId), gt(sessions.expiresAt, new Date())),
      with: {
        user: {
          columns: {
            id: true,
            username: true,
            createdAt: true,
            updatedAt: true,
          },
        },
      },
    });

    if (!session) {
      return null;
    }

    return {
      id: session.user.id,
      username: session.user.username,
      created_at: session.user.createdAt.toISOString(),
      updated_at: session.user.updatedAt.toISOString(),
    };
  }

  async cleanupExpiredSessions(): Promise<number> {
    const result = await db
      .delete(sessionsTable)
      .where(lte(sessionsTable.expiresAt, new Date()));

    return result.count ?? 0;
  }

  async getMe(userId: number): Promise<User> {
    const user = await db.query.usersTable.findFirst({
      where: (users, { eq }) => eq(users.id, userId),
      columns: {
        id: true,
        username: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!user) {
      throw new UnauthorizedError("User not found");
    }

    return {
      id: user.id,
      username: user.username,
      created_at: user.createdAt.toISOString(),
      updated_at: user.updatedAt.toISOString(),
    };
  }
}

export const authService = new AuthService();
