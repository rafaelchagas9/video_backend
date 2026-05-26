import bcrypt from "bcrypt";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { db } from "@/config/drizzle";
import { env } from "@/config/env";
import * as schema from "@/database/schema";

function getTrustedOrigins(): string[] {
  return [env.BASE_URL, ...env.CORS_ORIGINS.split(",")]
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

export const auth = betterAuth({
  appName: "Video Streaming Backend",
  baseURL: env.BASE_URL,
  secret: env.SESSION_SECRET,
  trustedOrigins: getTrustedOrigins(),
  database: drizzleAdapter(db, {
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
