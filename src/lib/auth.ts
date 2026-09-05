import bcrypt from "bcrypt";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { db, type DrizzleTransaction } from "@/config/drizzle";
import { sql } from "drizzle-orm";
import { ForbiddenError } from "@/utils/errors";
import { env } from "@/config/env";
import * as schema from "@/database/schema";

function getTrustedOrigins(): string[] {
  return [env.BASE_URL, ...env.CORS_ORIGINS.split(",")]
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function createAuth(
  database: typeof db | DrizzleTransaction,
  disableSignUp = true
) {
  return betterAuth({
    appName: "Video Streaming Backend",
    baseURL: env.BASE_URL,
    secret: env.SESSION_SECRET,
    trustedOrigins: getTrustedOrigins(),
    database: drizzleAdapter(database, {
      provider: "pg",
      schema: {
        ...schema,
        user: schema.usersTable,
        users: schema.usersTable,
        session: schema.sessionsTable,
        sessions: schema.sessionsTable,
        account: schema.accountsTable,
        accounts: schema.accountsTable,
        verification: schema.verificationsTable,
        verifications: schema.verificationsTable,
      },
    }),
    emailAndPassword: {
      enabled: true,
      disableSignUp,
      autoSignIn: false,
      minPasswordLength: 8,
      maxPasswordLength: 100,
      password: {
        hash: async (password) => bcrypt.hash(password, 12),
        verify: async ({ hash, password }) => bcrypt.compare(password, hash),
      },
    },
    user: {
      modelName: "users",
      fields: {
        emailVerified: "emailVerified",
        createdAt: "createdAt",
        updatedAt: "updatedAt",
      },
      additionalFields: {
        username: {
          type: "string",
          required: false,
          unique: true,
          input: false,
        },
      },
    },
    session: {
      modelName: "sessions",
      expiresIn: env.SESSION_EXPIRY_HOURS * 60 * 60,
      fields: {
        userId: "userId",
        expiresAt: "expiresAt",
        createdAt: "createdAt",
        updatedAt: "updatedAt",
        ipAddress: "ipAddress",
        userAgent: "userAgent",
      },
    },
    account: {
      modelName: "accounts",
      fields: {
        accountId: "accountId",
        providerId: "providerId",
        userId: "userId",
        accessToken: "accessToken",
        refreshToken: "refreshToken",
        idToken: "idToken",
        accessTokenExpiresAt: "accessTokenExpiresAt",
        refreshTokenExpiresAt: "refreshTokenExpiresAt",
        createdAt: "createdAt",
        updatedAt: "updatedAt",
      },
    },
    verification: {
      modelName: "verifications",
      fields: {
        expiresAt: "expiresAt",
        createdAt: "createdAt",
        updatedAt: "updatedAt",
      },
    },
    advanced: {
      cookies: {
        session_token: {
          name: "session_id",
        },
      },
      database: {
        generateId: (options) => {
          if (options.model === "user" || options.model === "users") {
            return false;
          }

          return crypto.randomUUID();
        },
      },
    },
  });
}

export const auth = createAuth(db);

/** Serialize bootstrap across processes and commit the owner and credential together. */
export async function withOwnerRegistration<T>(
  operation: (registrationAuth: ReturnType<typeof createAuth>) => Promise<T>
): Promise<T> {
  return db.transaction(async (transaction) => {
    await transaction.execute(sql`SELECT pg_advisory_xact_lock(8217346190123)`);
    const existing = await transaction
      .select({ id: schema.usersTable.id })
      .from(schema.usersTable)
      .limit(1);
    if (existing.length > 0) {
      throw new ForbiddenError(
        "Registration is closed: this library already has an owner"
      );
    }
    return operation(createAuth(transaction, false));
  });
}
