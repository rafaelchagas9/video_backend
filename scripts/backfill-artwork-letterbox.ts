/**
 * Re-derive artwork for videos whose source frame has letterbox/pillarbox bars.
 *
 * Bar trimming was added to the artwork pipeline after most artwork had already
 * been generated, so existing assets were cut from padded frames: a 2.39:1
 * trailer mastered into a 16:9 container produces a 2:3 poster that is a 16:9
 * pillar floating in black. New artwork is correct; old artwork is not.
 *
 * This deliberately does *not* regenerate everything. It re-extracts each
 * video's stored source frame — cheap, one seek — runs the same detector the
 * pipeline uses, and only queues a regeneration when bars are actually found.
 * On a library that is mostly 16:9 native that turns a full re-encode into a
 * scan plus a handful of jobs.
 *
 * Dry run by default. Pass `--apply` to actually queue work.
 *
 *   bun scripts/backfill-artwork-letterbox.ts
 *   bun scripts/backfill-artwork-letterbox.ts --apply
 *   bun scripts/backfill-artwork-letterbox.ts --apply --limit 50
 */

import { mkdir, rm } from "fs/promises";
import { join } from "path";
import { randomUUID } from "crypto";
import sharp from "sharp";
import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "@/config/drizzle";
import { env } from "@/config/env";
import { artworkAssetsTable, videosTable } from "@/database/schema";
import { getFrameExtractionService } from "@/modules/frame-extraction";
import { detectContentBox } from "@/modules/artwork/artwork.processing";
import { artworkService } from "@/modules/artwork/artwork.service";

const apply = process.argv.includes("--apply");
const limitIndex = process.argv.indexOf("--limit");
const limit = limitIndex === -1 ? null : Number(process.argv[limitIndex + 1]);

interface Candidate {
  videoId: number;
  title: string;
  filePath: string;
  timestamp: number;
}

async function loadCandidates(): Promise<Candidate[]> {
  // The card variant is the reference: every generated set has one, and it
  // records the timestamp the whole set was cut from.
  const rows = await db
    .select({
      videoId: artworkAssetsTable.videoId,
      timestamp: artworkAssetsTable.sourceTimestampSeconds,
      title: videosTable.title,
      fileName: videosTable.fileName,
      filePath: videosTable.filePath,
      isAvailable: videosTable.isAvailable,
    })
    .from(artworkAssetsTable)
    .innerJoin(videosTable, eq(videosTable.id, artworkAssetsTable.videoId))
    .where(
      and(
        eq(artworkAssetsTable.variant, "card"),
        isNotNull(artworkAssetsTable.sourceTimestampSeconds),
      ),
    );

  const candidates = rows
    .filter((row) => row.isAvailable)
    .map((row) => ({
      videoId: row.videoId,
      title: row.title?.trim() || row.fileName,
      filePath: row.filePath,
      timestamp: row.timestamp ?? 0,
    }));

  return limit && limit > 0 ? candidates.slice(0, limit) : candidates;
}

async function main(): Promise<void> {
  if (env.DEMO_MODE) {
    // `requestGeneration` is a no-op under demo mode, so a run here would report
    // work it never queued. Demo artwork is rebuilt by its own generator.
    console.error("DEMO_MODE is on — artwork generation is disabled. Aborting.");
    process.exit(1);
  }

  const candidates = await loadCandidates();
  console.log(`Scanning ${candidates.length} videos with existing artwork…\n`);

  const frameExtraction = getFrameExtractionService();
  const workDir = join(env.ARTWORK_DIR, ".work", `backfill-${randomUUID()}`);
  await mkdir(workDir, { recursive: true });

  const affected: Array<{ videoId: number; title: string; detail: string }> = [];
  let scanned = 0;
  let failed = 0;

  try {
    for (const candidate of candidates) {
      scanned += 1;
      try {
        const framePath = await frameExtraction.extractFrame({
          videoPath: candidate.filePath,
          timestampSeconds: candidate.timestamp,
          outputDir: workDir,
          outputFormat: "jpg",
          quality: 90,
        });
        const metadata = await sharp(framePath).metadata();
        if (!metadata.width || !metadata.height) continue;

        const box = await detectContentBox(framePath, metadata.width, metadata.height);
        await rm(framePath, { force: true });

        if (box.width === metadata.width && box.height === metadata.height) continue;

        affected.push({
          videoId: candidate.videoId,
          title: candidate.title,
          detail:
            `${metadata.width}x${metadata.height} -> ${box.width}x${box.height} ` +
            `@${box.left},${box.top}`,
        });
      } catch (error) {
        failed += 1;
        console.warn(`  ! ${candidate.title}: ${(error as Error).message}`);
      }

      if (scanned % 25 === 0) {
        console.log(`  …${scanned}/${candidates.length} scanned, ${affected.length} need re-deriving`);
      }
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }

  console.log(`\nScanned ${scanned}, ${failed} unreadable, ${affected.length} carry bars.\n`);
  for (const item of affected) {
    console.log(`  ${String(item.videoId).padStart(6)}  ${item.title}`);
    console.log(`          ${item.detail}`);
  }

  if (affected.length === 0) return;

  if (!apply) {
    console.log(`\nDry run. Re-run with --apply to queue ${affected.length} regenerations.`);
    return;
  }

  // Every variant, forced — a partial set would leave the poster trimmed and the
  // card not, which is worse than leaving all of them alone.
  console.log(`\nQueueing ${affected.length} regenerations…`);
  for (const item of affected) {
    await artworkService.requestGeneration(item.videoId, {
      variants: ["card", "poster", "square", "hero", "title"],
      force: true,
    });
  }
  console.log("Queued. The artwork worker will process them in the background.");
}

await main();
process.exit(0);
