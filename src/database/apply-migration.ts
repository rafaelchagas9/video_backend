import { getDatabase } from '@/config/database';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const migrationFile = process.argv[2];

if (!migrationFile) {
  console.error('Usage: bun src/database/apply-migration.ts <migration-file>');
  process.exit(1);
}

const migrationPath = resolve(process.cwd(), 'src/database/migrations', migrationFile);

console.log(`Applying migration: ${migrationFile}`);

const db = getDatabase();
const migration = readFileSync(migrationPath, 'utf-8');

// Split by semicolon and execute each statement
// Filter out comments and empty lines
const statements = migration
  .split(';')
  .map((s) => s.trim())
  .filter((s) => s && !s.startsWith('--') && s.length > 0);

let successCount = 0;
let errorCount = 0;

for (const statement of statements) {
  try {
    db.exec(statement);
    successCount++;
    const preview = statement.substring(0, 80).replace(/\s+/g, ' ');
    console.log(`✓ Executed: ${preview}${statement.length > 80 ? '...' : ''}`);
  } catch (error: any) {
    errorCount++;
    const preview = statement.substring(0, 80).replace(/\s+/g, ' ');
    console.error(`✗ Failed: ${preview}`, error.message);
  }
}

// Verify indexes were created
const indexes = db
  .prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name"
  )
  .all() as { name: string }[];

console.log(`\n✅ Migration applied: ${successCount} statements executed, ${errorCount} errors`);
console.log(`\n📊 Database indexes (${indexes.length} total):`);
indexes.forEach((idx) => console.log(`  - ${idx.name}`));

if (errorCount > 0) {
  console.error(`\n⚠️  Migration completed with ${errorCount} errors`);
  process.exit(1);
}

console.log('\n✅ Migration successful!');
