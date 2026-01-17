#!/usr/bin/env bun

/**
 * SQLite Data Export Script
 * Exports all data from SQLite database to JSON files for PostgreSQL migration
 */

import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

const DB_PATH = process.env.DATABASE_PATH || './data/database.db';
const EXPORT_DIR = './data/migration';

// Table export order (respects foreign key dependencies)
const TABLES_TO_EXPORT = [
  // Foundation tables (no dependencies)
  'users',
  'app_settings',
  'watched_directories',

  // Core content tables
  'videos',
  'scan_logs',

  // Content entities (independent)
  'creators',
  'studios',
  'platforms',
  'tags',

  // Many-to-many relationships
  'video_creators',
  'video_studios',
  'video_tags',
  'creator_platforms',
  'creator_studios',
  'creator_social_links',
  'studio_social_links',

  // User features
  'playlists',
  'favorites',
  'bookmarks',
  'ratings',
  'video_stats',
  'video_metadata',
  'playlist_videos',

  // Media processing
  'conversion_jobs',
  'thumbnails',
  'storyboards',

  // Statistics
  'stats_storage_snapshots',
  'stats_library_snapshots',
  'stats_content_snapshots',
  'stats_usage_snapshots',

  // Triage
  'triage_progress',

  // Tagging rules
  'tagging_rules',
  'tagging_rule_conditions',
  'tagging_rule_actions',
  'tagging_rule_log',

  // Sessions (can be last)
  'sessions',
];

// Fields that need boolean transformation (0/1 → false/true)
const BOOLEAN_FIELDS: Record<string, string[]> = {
  watched_directories: ['is_active', 'auto_scan'],
  videos: ['is_available', 'is_deleted'],
  video_stats: ['session_play_counted'],
  creators: ['is_verified'],
  studios: ['is_verified'],
  creator_platforms: ['is_primary'],
  conversion_jobs: ['delete_original', 'is_deleted'],
  thumbnails: ['auto_generated'],
  tagging_rules: ['is_enabled'],
  tagging_rule_log: ['success'],
  triage_progress: [],
};

interface ExportStats {
  table: string;
  rowCount: number;
  filePath: string;
}

function transformBooleanFields(table: string, row: any): any {
  const booleanFields = BOOLEAN_FIELDS[table] || [];

  if (booleanFields.length === 0) {
    return row;
  }

  const transformed = { ...row };

  for (const field of booleanFields) {
    if (field in transformed) {
      transformed[field] = transformed[field] === 1;
    }
  }

  return transformed;
}

function exportTable(db: Database, tableName: string): ExportStats {
  console.log(`Exporting ${tableName}...`);

  // Get all rows from table
  const rows = db.prepare(`SELECT * FROM ${tableName}`).all();

  // Transform boolean fields
  const transformedRows = rows.map((row) => transformBooleanFields(tableName, row));

  // Write to JSON file
  const filePath = join(EXPORT_DIR, `${tableName}.json`);
  writeFileSync(filePath, JSON.stringify(transformedRows, null, 2), 'utf-8');

  return {
    table: tableName,
    rowCount: rows.length,
    filePath,
  };
}

function main() {
  console.log('='.repeat(60));
  console.log('SQLite to PostgreSQL Migration - Data Export');
  console.log('='.repeat(60));
  console.log();

  // Verify SQLite database exists
  if (!existsSync(DB_PATH)) {
    console.error(`❌ SQLite database not found at: ${DB_PATH}`);
    process.exit(1);
  }

  // Create export directory
  if (!existsSync(EXPORT_DIR)) {
    mkdirSync(EXPORT_DIR, { recursive: true });
    console.log(`📁 Created export directory: ${EXPORT_DIR}`);
  }

  // Open SQLite database
  const db = new Database(DB_PATH, { readonly: true });
  console.log(`✅ Opened SQLite database: ${DB_PATH}`);
  console.log();

  // Export all tables
  const stats: ExportStats[] = [];
  let totalRows = 0;

  for (const table of TABLES_TO_EXPORT) {
    try {
      const stat = exportTable(db, table);
      stats.push(stat);
      totalRows += stat.rowCount;
      console.log(`   ✅ ${stat.rowCount.toString().padStart(6)} rows → ${stat.filePath}`);
    } catch (error) {
      console.error(`   ❌ Failed to export ${table}:`, error);
    }
  }

  db.close();

  // Print summary
  console.log();
  console.log('='.repeat(60));
  console.log('Export Summary');
  console.log('='.repeat(60));
  console.log();
  console.log(`Total Tables:  ${stats.length}`);
  console.log(`Total Rows:    ${totalRows.toLocaleString()}`);
  console.log(`Export Dir:    ${EXPORT_DIR}`);
  console.log();

  // Print table breakdown
  console.log('Table Breakdown:');
  console.log('-'.repeat(60));

  const sorted = stats.sort((a, b) => b.rowCount - a.rowCount);
  for (const stat of sorted) {
    const paddedName = stat.table.padEnd(30);
    const paddedCount = stat.rowCount.toString().padStart(6);
    console.log(`${paddedName} ${paddedCount} rows`);
  }

  console.log();
  console.log('✅ Export completed successfully!');
}

main();
