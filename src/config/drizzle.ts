import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from './env';
import * as schema from '@/database/schema';

const connectionString = `postgres://${env.POSTGRES_USER}:${env.POSTGRES_PASSWORD}@${env.POSTGRES_HOST}:${env.POSTGRES_PORT}/${env.POSTGRES_DB}`;

const queryClient = postgres(connectionString, {
  max: env.POSTGRES_MAX_CONNECTIONS,
  idle_timeout: 30,
  connect_timeout: 10,
});

export const db = drizzle(queryClient, { schema });
export type DrizzleTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Graceful shutdown
async function closeDatabase() {
  await queryClient.end({ timeout: 5 });
}

process.on('SIGINT', closeDatabase);
process.on('SIGTERM', closeDatabase);
