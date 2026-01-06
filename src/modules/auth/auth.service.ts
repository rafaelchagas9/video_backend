import bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { getDatabase } from '@/config/database';
import { env } from '@/config/env';
import {
  ConflictError,
  UnauthorizedError,
  ValidationError,
} from '@/utils/errors';
import type {
  RegisterInput,
  LoginInput,
  User,
  Session,
  AuthenticatedUser,
} from './auth.types';

const BCRYPT_ROUNDS = 12;

export class AuthService {
  private get db() {
    return getDatabase();
  }

  async register(input: RegisterInput): Promise<User> {
    // Check if any user already exists (single-user system)
    const existingUserCount = this.db
      .prepare('SELECT COUNT(*) as count FROM users')
      .get() as { count: number };

    if (existingUserCount.count > 0) {
      throw new ConflictError('A user already exists. Registration is disabled.');
    }

    // Check if username is taken (redundant but safe)
    const existingUser = this.db
      .prepare('SELECT id FROM users WHERE username = ?')
      .get(input.username);

    if (existingUser) {
      throw new ConflictError('Username already exists');
    }

    // Hash password
    const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);

    // Create user
    const result = this.db
      .prepare(
        `INSERT INTO users (username, password_hash)
         VALUES (?, ?)
         RETURNING id, username, created_at, updated_at`
      )
      .get(input.username, passwordHash) as User;

    return result;
  }

  async login(input: LoginInput): Promise<AuthenticatedUser> {
    // Find user
    const user = this.db
      .prepare(
        `SELECT id, username, password_hash, created_at, updated_at
         FROM users
         WHERE username = ?`
      )
      .get(input.username) as (User & { password_hash: string }) | undefined;

    if (!user) {
      throw new UnauthorizedError('Invalid credentials');
    }

    // Verify password
    const isValid = await bcrypt.compare(input.password, user.password_hash);

    if (!isValid) {
      throw new UnauthorizedError('Invalid credentials');
    }

    // Create session
    const sessionId = randomBytes(32).toString('hex');
    const expiresAt = new Date(
      Date.now() + env.SESSION_EXPIRY_HOURS * 60 * 60 * 1000
    ).toISOString();

    this.db
      .prepare(
        `INSERT INTO sessions (id, user_id, expires_at)
         VALUES (?, ?, ?)`
      )
      .run(sessionId, user.id, expiresAt);

    return {
      id: user.id,
      username: user.username,
      created_at: user.created_at,
      updated_at: user.updated_at,
      sessionId,
    };
  }

  async logout(sessionId: string): Promise<void> {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
  }

  async validateSession(sessionId: string): Promise<User | null> {
    const session = this.db
      .prepare(
        `SELECT s.id, s.user_id, s.expires_at, u.username, u.created_at, u.updated_at
         FROM sessions s
         JOIN users u ON s.user_id = u.id
         WHERE s.id = ? AND s.expires_at > datetime('now')`
      )
      .get(sessionId) as (Session & User) | undefined;

    if (!session) {
      return null;
    }

    return {
      id: session.user_id,
      username: session.username,
      created_at: session.created_at,
      updated_at: session.updated_at,
    };
  }

  async cleanupExpiredSessions(): Promise<number> {
    const result = this.db
      .prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')")
      .run();

    return result.changes;
  }

  async getMe(userId: number): Promise<User> {
    const user = this.db
      .prepare(
        `SELECT id, username, created_at, updated_at
         FROM users
         WHERE id = ?`
      )
      .get(userId) as User | undefined;

    if (!user) {
      throw new UnauthorizedError('User not found');
    }

    return user;
  }
}

export const authService = new AuthService();
