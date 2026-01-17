import { Pool } from "pg";
import type { PoolClient, QueryResult } from "pg";
import { env } from "./env";

let pool: Pool | null = null;

/**
 * PostgreSQL Connection Pool Configuration
 */
function createPool(): Pool {
  return new Pool({
    host: env.POSTGRES_HOST,
    port: env.POSTGRES_PORT,
    database: env.POSTGRES_DB,
    user: env.POSTGRES_USER,
    password: env.POSTGRES_PASSWORD,
    max: env.POSTGRES_MAX_CONNECTIONS,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  });
}

/**
 * Get PostgreSQL connection pool
 * Returns a pool that can be used to query the database
 */
export function getDatabase(): Pool {
  if (!pool) {
    pool = createPool();

    // Set up event handlers
    pool.on("error", (err) => {
      console.error("Unexpected error on idle PostgreSQL client", err);
    });

    pool.on("connect", () => {
      console.log("New PostgreSQL client connected");
    });

    console.log("PostgreSQL connection pool initialized");
  }

  return pool;
}

/**
 * Execute a query with parameters
 * Usage: await query('SELECT * FROM users WHERE id = $1', [userId])
 */
export async function query<
  T extends Record<string, unknown> = Record<string, unknown>,
>(text: string, params?: unknown[]): Promise<QueryResult<T>> {
  const db = getDatabase();
  return db.query<T>(text, params);
}

/**
 * Execute a query and return first row or null
 * Usage: const user = await queryOne('SELECT * FROM users WHERE id = $1', [userId])
 */
export async function queryOne<
  T extends Record<string, unknown> = Record<string, unknown>,
>(text: string, params?: unknown[]): Promise<T | null> {
  const result = await query<T>(text, params);
  return result.rows[0] || null;
}

/**
 * Execute a query and return all rows
 * Usage: const users = await queryAll('SELECT * FROM users')
 */
export async function queryAll<
  T extends Record<string, unknown> = Record<string, unknown>,
>(text: string, params?: unknown[]): Promise<T[]> {
  const result = await query<T>(text, params);
  return result.rows;
}

/**
 * Execute a query within a transaction
 * Usage:
 * await transaction(async (client) => {
 *   await client.query('INSERT INTO users (name) VALUES ($1)', ['Alice']);
 *   await client.query('INSERT INTO profiles (user_id) VALUES ($1)', [userId]);
 * });
 */
export async function transaction<T>(
  callback: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const db = getDatabase();
  const client = await db.connect();

  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Close database connection pool
 */
export async function closeDatabase(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    console.log("PostgreSQL connection pool closed");
  }
}

/**
 * Test database connection
 */
export async function testConnection(): Promise<boolean> {
  try {
    const db = getDatabase();
    const result = await db.query("SELECT 1 as test");
    return result.rows[0].test === 1;
  } catch (error) {
    console.error("Database connection test failed:", error);
    return false;
  }
}

// Graceful shutdown
process.on("SIGINT", async () => {
  await closeDatabase();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await closeDatabase();
  process.exit(0);
});
