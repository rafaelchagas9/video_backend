#!/usr/bin/env bun

/**
 * PostgreSQL Data Import Script
 * Imports data from JSON files exported from SQLite into PostgreSQL
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';

const PG_CONFIG = {
  host: process.env.POSTGRES_HOST || 'localhost',
  port: parseInt(process.env.POSTGRES_PORT || '5432'),
  database: process.env.POSTGRES_DB || 'video_streaming_db',
  user: process.env.POSTGRES_USER || 'vueverse',
  password: process.env.POSTGRES_PASSWORD || 'vueverse_dev_password',
};

const EXPORT_DIR = './data/migration';

// Import order (same as export order, respects foreign keys)
const TABLES_TO_IMPORT = [
  'users',
  'app_settings',
  'watched_directories',
  'videos',
  'scan_logs',
  'creators',
  'studios',
  'platforms',
  'tags',
  'video_creators',
  'video_studios',
  'video_tags',
  'creator_platforms',
  'creator_studios',
  'creator_social_links',
  'studio_social_links',
  'playlists',
  'favorites',
  'bookmarks',
  'ratings',
  'video_stats',
  'video_metadata',
  'playlist_videos',
  'conversion_jobs',
  'thumbnails',
  'storyboards',
  'stats_storage_snapshots',
  'stats_library_snapshots',
  'stats_content_snapshots',
  'stats_usage_snapshots',
  'triage_progress',
  'sessions',
];

// Tables with SERIAL primary keys that need sequence reset
// Excludes junction tables (no id column, composite primary keys)
const SERIAL_TABLES = [
  'users',
  'watched_directories',
  'videos',
  'scan_logs',
  'creators',
  'studios',
  'platforms',
  'tags',
  'creator_platforms',
  'creator_social_links',
  'studio_social_links',
  'playlists',
  'bookmarks',
  'ratings',
  'video_metadata',
  'conversion_jobs',
  'thumbnails',
  'storyboards',
  'stats_storage_snapshots',
  'stats_library_snapshots',
  'stats_content_snapshots',
  'stats_usage_snapshots',
  'triage_progress',
];

interface ImportStats {
  table: string;
  rowsImported: number;
  sequenceReset?: number;
}

async function importTable(client: Client, tableName: string): Promise<ImportStats> {
  const filePath = join(EXPORT_DIR, `${tableName}.json`);

  if (!existsSync(filePath)) {
    console.log(`   ⚠️  Skipping ${tableName} (file not found)`);
    return { table: tableName, rowsImported: 0 };
  }

  // Read JSON data
  const jsonData = readFileSync(filePath, 'utf-8');
  const rows = JSON.parse(jsonData);

  if (rows.length === 0) {
    console.log(`   ⏭️  Skipping ${tableName} (no data)`);
    return { table: tableName, rowsImported: 0 };
  }

  // Get column names from first row
  const columns = Object.keys(rows[0]);

  // Build INSERT query with placeholders
  const placeholders = rows
    .map((_, rowIndex) => {
      const rowPlaceholders = columns.map((_, colIndex) => `$${rowIndex * columns.length + colIndex + 1}`).join(', ');
      return `(${rowPlaceholders})`;
    })
    .join(', ');

  const query = `
    INSERT INTO ${tableName} (${columns.join(', ')})
    VALUES ${placeholders}
  `;

  // Flatten all values for parameterized query
  const values = rows.flatMap((row: any) => columns.map((col) => row[col]));

  // Execute import
  await client.query(query, values);

  // Reset sequence for SERIAL columns if needed
  let sequenceValue: number | undefined;
  if (SERIAL_TABLES.includes(tableName)) {
    const result = await client.query(`
      SELECT setval(pg_get_serial_sequence('${tableName}', 'id'), COALESCE(MAX(id), 1), true)
      FROM ${tableName}
    `);
    sequenceValue = parseInt(result.rows[0].setval);
  }

  return {
    table: tableName,
    rowsImported: rows.length,
    sequenceReset: sequenceValue,
  };
}

async function validateImport(client: Client): Promise<void> {
  console.log();
  console.log('='.repeat(60));
  console.log('Validating Import');
  console.log('='.repeat(60));
  console.log();

  // Count rows in each table
  for (const table of TABLES_TO_IMPORT) {
    const result = await client.query(`SELECT COUNT(*) as count FROM ${table}`);
    const count = parseInt(result.rows[0].count);
    console.log(`${table.padEnd(30)} ${count.toString().padStart(6)} rows`);
  }
}

async function main() {
  console.log('='.repeat(60));
  console.log('SQLite to PostgreSQL Migration - Data Import');
  console.log('='.repeat(60));
  console.log();

  // Verify export directory exists
  if (!existsSync(EXPORT_DIR)) {
    console.error(`❌ Export directory not found: ${EXPORT_DIR}`);
    console.error('   Run export-sqlite-data.ts first');
    process.exit(1);
  }

  // Connect to PostgreSQL
  const client = new Client(PG_CONFIG);

  try {
    await client.connect();
    console.log(`✅ Connected to PostgreSQL: ${PG_CONFIG.database}`);
    console.log();

    // Import all tables
    const stats: ImportStats[] = [];
    let totalRows = 0;

    for (const table of TABLES_TO_IMPORT) {
      console.log(`Importing ${table}...`);

      try {
        const stat = await importTable(client, table);
        stats.push(stat);
        totalRows += stat.rowsImported;

        if (stat.rowsImported > 0) {
          const sequenceInfo = stat.sequenceReset ? ` (seq: ${stat.sequenceReset})` : '';
          console.log(`   ✅ ${stat.rowsImported.toString().padStart(6)} rows imported${sequenceInfo}`);
        }
      } catch (error) {
        console.error(`   ❌ Failed to import ${table}:`, error);
        throw error; // Stop on first error
      }
    }

    // Validate import
    await validateImport(client);

    // Print summary
    console.log();
    console.log('='.repeat(60));
    console.log('Import Summary');
    console.log('='.repeat(60));
    console.log();
    console.log(`Total Tables:  ${stats.filter((s) => s.rowsImported > 0).length}`);
    console.log(`Total Rows:    ${totalRows.toLocaleString()}`);
    console.log();

    // Print top tables by row count
    console.log('Top Tables by Row Count:');
    console.log('-'.repeat(60));

    const sorted = stats
      .filter((s) => s.rowsImported > 0)
      .sort((a, b) => b.rowsImported - a.rowsImported)
      .slice(0, 10);

    for (const stat of sorted) {
      const paddedName = stat.table.padEnd(30);
      const paddedCount = stat.rowsImported.toString().padStart(6);
      console.log(`${paddedName} ${paddedCount} rows`);
    }

    console.log();
    console.log('✅ Import completed successfully!');
  } catch (error) {
    console.error();
    console.error('❌ Import failed:', error);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
