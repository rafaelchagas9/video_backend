#!/usr/bin/env bun
/**
 * Script to generate storyboards for videos that are missing them.
 * Ordered by video duration (smallest to longest).
 * Supports concurrent execution.
 *
 * Usage:
 *   bun scripts/generate-missing-storyboards.ts [options]
 *
 * Options:
 *   --concurrency <n> Number of parallel generations (default: STORYBOARD_MAX_CONCURRENT or 1)
 *   --limit <n>       Limit the number of videos to process
 *   --dry-run         Preview which videos are missing storyboards without generating them
 *   --help, -h        Show this help message
 */

import { db } from "../src/config/drizzle";
// Remove global DB connection closing listeners registered in drizzle.ts
process.removeAllListeners("SIGINT");
process.removeAllListeners("SIGTERM");

import { videosTable, storyboardsTable } from "../src/database/schema";
import { isNull, eq, and, isNotNull, gt, asc } from "drizzle-orm";
import { storyboardsService } from "../src/modules/storyboards/storyboards.service";
import { logger } from "../src/utils/logger";
import { env } from "../src/config/env";

const argv = process.argv.slice(2);
const helpRequested = argv.includes("--help") || argv.includes("-h");
const dryRun = argv.includes("--dry-run");

const getArgValue = (flag: string): string | null => {
  const index = argv.indexOf(flag);
  if (index === -1) return null;
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
};

const limitValue = getArgValue("--limit");
const limit = limitValue ? Number.parseInt(limitValue, 10) : null;

const concurrencyValue = getArgValue("--concurrency");
const concurrency = Math.max(1, concurrencyValue
  ? Number.parseInt(concurrencyValue, 10)
  : env.STORYBOARD_MAX_CONCURRENT || 1
);

if (helpRequested) {
  console.log(`Usage: bun scripts/generate-missing-storyboards.ts [options]

Options:
  --concurrency <n> Number of parallel generations (default: STORYBOARD_MAX_CONCURRENT or 1)
  --limit <n>       Limit the number of videos to process
  --dry-run         Preview which videos are missing storyboards without generating them
  --help, -h        Show this help message
`);
  process.exit(0);
}

// Graceful shutdown management
let isStopping = false;
const activeTasks = new Set<string>();

process.on("SIGINT", () => {
  if (isStopping) {
    console.log("\n🛑 [Forced Stop] Exiting immediately.");
    process.exit(130);
  }
  isStopping = true;
  console.log("\n⏳ [Graceful Stop] Signal received.");
  if (activeTasks.size > 0) {
    console.log("   Finishing active storyboards for:");
    activeTasks.forEach((info) => console.log(`   - ${info}`));
  }
  console.log("   Press Ctrl+C again to force exit immediately.");
});

process.on("SIGTERM", () => {
  isStopping = true;
  console.log("\n⏳ [Graceful Stop] Termination signal received. Finishing active tasks before exiting...");
});

// Format duration into readable MM:SS or HH:MM:SS
function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }
  return `${m}:${s.toString().padStart(2, "0")}`;
}

async function run(): Promise<void> {
  console.log("🔍 Scanning database for videos missing storyboards...");

  // Query videos that:
  // 1. Have no matching storyboard
  // 2. Are marked as available
  // 3. Have a valid duration > 0 (required for storyboard generation)
  const rows = await db
    .select({
      id: videosTable.id,
      fileName: videosTable.fileName,
      title: videosTable.title,
      durationSeconds: videosTable.durationSeconds,
    })
    .from(videosTable)
    .leftJoin(storyboardsTable, eq(videosTable.id, storyboardsTable.videoId))
    .where(
      and(
        isNull(storyboardsTable.videoId),
        eq(videosTable.isAvailable, true),
        isNotNull(videosTable.durationSeconds),
        gt(videosTable.durationSeconds, 0)
      )
    )
    .orderBy(asc(videosTable.durationSeconds));

  const totalMissing = rows.length;

  if (totalMissing === 0) {
    console.log("✅ All available videos already have storyboards!");
    return;
  }

  // Apply limit if specified
  const targets = limit ? rows.slice(0, limit) : rows;
  const toProcessCount = targets.length;

  console.log(`\nFound ${totalMissing} video(s) missing storyboards.`);
  console.log(`Ordered by duration (shortest first).`);
  console.log(`Concurrency: ${concurrency} worker(s).\n`);

  if (dryRun) {
    console.log("🔍 DRY RUN - Listing videos that would be processed:");
    console.log("====================================================");
    targets.forEach((video, idx) => {
      const durationStr = video.durationSeconds ? formatDuration(video.durationSeconds) : "Unknown";
      console.log(`[${idx + 1}/${toProcessCount}] ID: ${video.id} | Duration: ${durationStr} | ${video.title || video.fileName}`);
    });
    console.log("====================================================");
    console.log(`\n🔍 Dry run completed. No storyboards were generated.`);
    return;
  }

  let successful = 0;
  let failed = 0;
  let currentIndex = 0;
  const startTime = Date.now();

  async function worker(workerId: number) {
    while (!isStopping && currentIndex < toProcessCount) {
      const i = currentIndex++;
      if (i >= toProcessCount) break;

      const video = targets[i];
      const durationStr = video.durationSeconds ? formatDuration(video.durationSeconds) : "Unknown";
      const displayName = video.title || video.fileName;
      const currentVideoInfo = `"${displayName}" (ID: ${video.id}, Duration: ${durationStr})`;

      activeTasks.add(currentVideoInfo);

      const progressPercent = (((i) / toProcessCount) * 100).toFixed(1);
      console.log(`[Worker ${workerId}] [${i + 1}/${toProcessCount}] (${progressPercent}%) Current Task: Generating storyboard for ${currentVideoInfo}...`);

      const itemStart = Date.now();
      try {
        // Generate the storyboard
        await storyboardsService.generate(video.id);
        
        const itemDuration = ((Date.now() - itemStart) / 1000).toFixed(1);
        console.log(`[Worker ${workerId}] ✅ Successfully generated storyboard for ${currentVideoInfo} in ${itemDuration}s\n`);
        successful++;
      } catch (error) {
        const itemDuration = ((Date.now() - itemStart) / 1000).toFixed(1);
        console.error(`[Worker ${workerId}] ❌ Failed to generate storyboard for ${currentVideoInfo} after ${itemDuration}s:`, error instanceof Error ? error.message : String(error));
        logger.error({ error, videoId: video.id }, "Script failed to generate storyboard");
        failed++;
      } finally {
        activeTasks.delete(currentVideoInfo);
      }
    }
  }

  console.log(`🚀 Starting generation using ${concurrency} worker(s)...\n`);
  const workers = Array.from({ length: concurrency }).map((_, idx) => worker(idx + 1));
  await Promise.all(workers);

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  const remainingCount = toProcessCount - (successful + failed);

  console.log("====================================================");
  console.log("               Execution Summary");
  console.log("====================================================");
  console.log(`Total Time Elapsed:    ${totalTime}s`);
  console.log(`Total Target Videos:   ${toProcessCount}`);
  console.log(`✅ Success:            ${successful}`);
  console.log(`❌ Failed:             ${failed}`);
  if (remainingCount > 0) {
    console.log(`⏳ Stopped/Skipped:    ${remainingCount}`);
  }
  console.log("====================================================");
}

run()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error("💥 Script crashed with unexpected error:", error);
    process.exit(1);
  });
