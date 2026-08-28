import { drizzle } from "drizzle-orm/postgres-js";
import type postgres from "postgres";
import { env } from "./env";
import { guardDatabaseAccess } from "./database-safety";
import * as schema from "@/database/schema";

type PostgresClient = ReturnType<typeof postgres>;

function createDatabase(client: PostgresClient) {
  return drizzle(client, { schema });
}

type ApplicationDatabase = ReturnType<typeof createDatabase>;

let queryClient: PostgresClient | null = null;

function createDemoDatabaseBoundary(): ApplicationDatabase {
  return new Proxy({} as ApplicationDatabase, {
    get(_target, property) {
      throw new Error(
        `Production PostgreSQL access is forbidden in DEMO_MODE (attempted db.${String(property)})`,
      );
    },
  });
}

async function createProductionDatabase(): Promise<ApplicationDatabase> {
  const { default: createPostgresClient } = await import("postgres");
  const target = {
    host: env.POSTGRES_HOST,
    port: env.POSTGRES_PORT,
    database: env.POSTGRES_DB,
    user: env.POSTGRES_USER,
  };
  const connectionString =
    `postgres://${env.POSTGRES_USER}:${env.POSTGRES_PASSWORD}` +
    `@${env.POSTGRES_HOST}:${env.POSTGRES_PORT}/${env.POSTGRES_DB}`;

  queryClient = createPostgresClient(connectionString, {
    max: env.POSTGRES_MAX_CONNECTIONS,
    idle_timeout: 30,
    connect_timeout: 10,
  });
  return guardDatabaseAccess(createDatabase(queryClient), target, () =>
    process.env.NODE_ENV === "test" || env.NODE_ENV === "test"
      ? "test"
      : process.env.NODE_ENV ?? env.NODE_ENV,
  );
}

export const db = env.DEMO_MODE
  ? createDemoDatabaseBoundary()
  : await createProductionDatabase();

export type DrizzleTransaction = Parameters<
  Parameters<ApplicationDatabase["transaction"]>[0]
>[0];

export function isProductionDatabaseClientInitialized(): boolean {
  return queryClient !== null;
}

export async function closeDrizzleDatabase(): Promise<void> {
  if (!queryClient) return;
  await queryClient.end({ timeout: 5 });
  queryClient = null;
}
