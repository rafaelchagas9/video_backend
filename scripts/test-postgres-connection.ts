#!/usr/bin/env bun

/**
 * Test PostgreSQL Connection
 * Verifies that the database configuration works correctly
 */

import { getDatabase, query, queryOne, queryAll, closeDatabase, testConnection } from '../src/config/database';

async function main() {
  console.log('='.repeat(60));
  console.log('PostgreSQL Connection Test');
  console.log('='.repeat(60));
  console.log();

  // Test 1: Basic connection
  console.log('Test 1: Basic Connection');
  const isConnected = await testConnection();
  console.log(`   ${isConnected ? '✅' : '❌'} Connection ${isConnected ? 'successful' : 'failed'}`);
  console.log();

  if (!isConnected) {
    console.error('❌ Connection failed, aborting tests');
    process.exit(1);
  }

  // Test 2: Query single row
  console.log('Test 2: Query Single Row');
  const user = await queryOne('SELECT * FROM users LIMIT 1');
  console.log(`   ✅ Found user:`, user);
  console.log();

  // Test 3: Query all rows
  console.log('Test 3: Query Multiple Rows');
  const videos = await queryAll('SELECT id, file_name FROM videos LIMIT 5');
  console.log(`   ✅ Found ${videos.length} videos:`);
  videos.forEach((v: any) => console.log(`      - ${v.id}: ${v.file_name}`));
  console.log();

  // Test 4: Count query
  console.log('Test 4: Count Query');
  const result = await query('SELECT COUNT(*) as count FROM videos');
  console.log(`   ✅ Total videos: ${result.rows[0].count}`);
  console.log();

  // Test 5: Parameterized query
  console.log('Test 5: Parameterized Query');
  const video = await queryOne('SELECT * FROM videos WHERE id = $1', [1]);
  console.log(`   ✅ Found video:`, video ? `${video.id}: ${video.file_name}` : 'null');
  console.log();

  // Test 6: Test pool
  console.log('Test 6: Connection Pool');
  const pool = getDatabase();
  console.log(`   ✅ Pool created: totalCount=${pool.totalCount}, idleCount=${pool.idleCount}, waitingCount=${pool.waitingCount}`);
  console.log();

  // Close connection
  await closeDatabase();
  console.log('✅ All tests passed!');
  console.log();
}

main().catch((error) => {
  console.error('❌ Test failed:', error);
  process.exit(1);
});
