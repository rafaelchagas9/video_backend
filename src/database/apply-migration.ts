import { query } from "@/config/database";
import { readFileSync } from "fs";
import { resolve } from "path";

const migrationFile = process.argv[2];

if (!migrationFile) {
  console.error("Usage: bun src/database/apply-migration.ts <migration-file>");
  process.exit(1);
}

const migrationPath = resolve(
  process.cwd(),
  "src/database/migrations",
  migrationFile,
);

console.log(`Applying migration: ${migrationFile}`);

const migration = readFileSync(migrationPath, "utf-8");

// Split by semicolon and execute each statement
// Filter out comments and empty lines
const statements = migration
  .split(";")
  .map((s) => s.trim())
  .filter((s) => s && !s.startsWith("--") && s.length > 0);

let successCount = 0;
let errorCount = 0;

async function runMigration() {
  for (const statement of statements) {
    try {
      await query(statement);
      successCount++;
      const preview = statement.substring(0, 80).replace(/\s+/g, " ");
      console.log(
        `✓ Executed: ${preview}${statement.length > 80 ? "..." : ""}`,
      );
    } catch (error: any) {
      errorCount++;
      const preview = statement.substring(0, 80).replace(/\s+/g, " ");
      console.error(`✗ Failed: ${preview}`, error.message);
    }
  }

  // Verify indexes were created (PostgreSQL version)
  const indexResult = await query(`
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname LIKE 'idx_%'
    ORDER BY indexname
  `);
  const indexes = indexResult.rows as { indexname: string }[];

  console.log(
    `\n✅ Migration applied: ${successCount} statements executed, ${errorCount} errors`,
  );
  console.log(`\n📊 Database indexes (${indexes.length} total):`);
  indexes.forEach((idx) => console.log(`  - ${idx.indexname}`));

  if (errorCount > 0) {
    console.error(`\n⚠️  Migration completed with ${errorCount} errors`);
    process.exit(1);
  }

  console.log("\n✅ Migration successful!");
  process.exit(0);
}

runMigration().catch((error) => {
  console.error("Migration failed:", error);
  process.exit(1);
});
