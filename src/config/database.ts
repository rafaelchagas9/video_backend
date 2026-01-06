import { Database } from 'bun:sqlite';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { env } from './env';

let db: Database | null = null;

export function getDatabase(): Database {
  // Check if database is open and valid
  if (db) {
    try {
      // Test if database is still open by running a simple query
      db.prepare('SELECT 1').get();
      return db;
    } catch (error) {
      // Database is closed, reset it
      db = null;
    }
  }

  const dbPath = resolve(process.cwd(), env.DATABASE_PATH);
  const dbDir = dirname(dbPath);

  // Ensure database directory exists
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
  }

  // Initialize database connection
  db = new Database(dbPath, {
    strict: true,
    create: true,
  });

  // Enable foreign keys
  db.exec('PRAGMA foreign_keys = ON');

  // Optimize SQLite for single-user scenario
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA cache_size = -64000'); // 64MB cache

  // Run migrations if database is new
  initializeSchema();

  return db;
}

function initializeSchema(): void {
  if (!db) {
    throw new Error('Database not initialized');
  }

  const schemaPath = resolve(process.cwd(), 'src/database/schema.sql');

  if (!existsSync(schemaPath)) {
    throw new Error(`Schema file not found at ${schemaPath}`);
  }

  const schema = readFileSync(schemaPath, 'utf-8');

  // Execute schema (create tables if they don't exist)
  db.exec(schema);

  console.log('Database schema initialized');
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// Graceful shutdown
process.on('SIGINT', closeDatabase);
process.on('SIGTERM', closeDatabase);
process.on('exit', closeDatabase);
