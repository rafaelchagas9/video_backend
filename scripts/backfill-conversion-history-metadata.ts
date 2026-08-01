#!/usr/bin/env bun
/**
 * Backfills the media metadata columns added to `conversion_history`.
 *
 * Rows written before those columns existed only know file sizes. This recovers
 * as much as is still knowable, in order of confidence:
 *
 *  1. ffprobe the file itself, when it is still on disk.
 *  2. Fall back to the linked `videos` row when its path matches the side being
 *     described (after an in-place replacement the video row *is* the output).
 *  3. Infer: conversions with target_resolution "original" ran without a scale
 *     filter, so source dimensions equal output dimensions; ffmpeg runs with
 *     `-fps_mode passthrough`, so frame rate is always preserved; and bitrate
 *     can be derived from size and duration.
 *
 * Only NULL columns are written, so the script is safe to re-run.
 *
 * Usage:
 *   bun scripts/backfill-conversion-history-metadata.ts [--dry-run] [--limit N]
 */
import { existsSync } from "fs";
import { eq } from "drizzle-orm";
import { db } from "@/config/drizzle";
import { conversionHistoryTable, videosTable } from "@/database/schema";
import { metadataService } from "@/modules/videos/metadata.service";

interface MediaFacts {
  width: number | null;
  height: number | null;
  fps: number | null;
  codec: string | null;
  audioCodec: string | null;
  bitrate: number | null;
  durationSeconds: number | null;
}

const EMPTY_FACTS: MediaFacts = {
  width: null,
  height: null,
  fps: null,
  codec: null,
  audioCodec: null,
  bitrate: null,
  durationSeconds: null,
};

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const limitFlag = args.indexOf("--limit");
const limit =
  limitFlag >= 0 && args[limitFlag + 1]
    ? Number.parseInt(args[limitFlag + 1]!, 10)
    : undefined;

const stats = {
  scanned: 0,
  updated: 0,
  skipped: 0,
  probedOutput: 0,
  probedSource: 0,
  fromVideoRow: 0,
  inferredSourceDims: 0,
  derivedSourceBitrate: 0,
  noDataAvailable: 0,
};

async function probe(filePath: string): Promise<MediaFacts | null> {
  if (!existsSync(filePath)) return null;

  try {
    const metadata = await metadataService.extractMetadata(filePath);

    return {
      width: metadata.width,
      height: metadata.height,
      fps: metadata.fps,
      codec: metadata.codec,
      audioCodec: metadata.audio_codec,
      bitrate: metadata.bitrate,
      durationSeconds: metadata.duration_seconds,
    };
  } catch {
    return null;
  }
}

function factsFromVideoRow(row: {
  width: number | null;
  height: number | null;
  fps: number | null;
  codec: string | null;
  audioCodec: string | null;
  bitrate: number | null;
  durationSeconds: number | null;
}): MediaFacts {
  return {
    width: row.width,
    height: row.height,
    fps: row.fps,
    codec: row.codec,
    audioCodec: row.audioCodec,
    bitrate: row.bitrate,
    durationSeconds: row.durationSeconds,
  };
}

function deriveBitrate(
  sizeBytes: number,
  durationSeconds: number | null,
): number | null {
  if (!durationSeconds || durationSeconds <= 0) return null;
  return Math.round((sizeBytes * 8) / durationSeconds);
}

async function main() {
  const rows = await db
    .select({
      id: conversionHistoryTable.id,
      videoId: conversionHistoryTable.videoId,
      sourceFilePath: conversionHistoryTable.sourceFilePath,
      outputFilePath: conversionHistoryTable.outputFilePath,
      targetResolution: conversionHistoryTable.targetResolution,
      originalSizeBytes: conversionHistoryTable.originalSizeBytes,
      outputSizeBytes: conversionHistoryTable.outputSizeBytes,
      durationSeconds: conversionHistoryTable.durationSeconds,
      sourceWidth: conversionHistoryTable.sourceWidth,
      sourceHeight: conversionHistoryTable.sourceHeight,
      sourceFps: conversionHistoryTable.sourceFps,
      sourceCodec: conversionHistoryTable.sourceCodec,
      sourceAudioCodec: conversionHistoryTable.sourceAudioCodec,
      sourceBitrate: conversionHistoryTable.sourceBitrate,
      outputWidth: conversionHistoryTable.outputWidth,
      outputHeight: conversionHistoryTable.outputHeight,
      outputFps: conversionHistoryTable.outputFps,
      outputCodec: conversionHistoryTable.outputCodec,
      outputAudioCodec: conversionHistoryTable.outputAudioCodec,
      outputBitrate: conversionHistoryTable.outputBitrate,
    })
    .from(conversionHistoryTable)
    .orderBy(conversionHistoryTable.id);

  const candidates = limit ? rows.slice(0, limit) : rows;
  console.log(
    `Scanning ${candidates.length} conversion history rows${dryRun ? " (dry run)" : ""}…`,
  );

  for (const row of candidates) {
    stats.scanned += 1;

    const alreadyComplete =
      row.durationSeconds !== null &&
      row.sourceBitrate !== null &&
      row.outputBitrate !== null &&
      row.outputWidth !== null;

    if (alreadyComplete) {
      stats.skipped += 1;
      continue;
    }

    const video = row.videoId
      ? (
          await db
            .select({
              filePath: videosTable.filePath,
              width: videosTable.width,
              height: videosTable.height,
              fps: videosTable.fps,
              codec: videosTable.codec,
              audioCodec: videosTable.audioCodec,
              bitrate: videosTable.bitrate,
              durationSeconds: videosTable.durationSeconds,
            })
            .from(videosTable)
            .where(eq(videosTable.id, row.videoId))
            .limit(1)
        )[0]
      : undefined;

    // --- output side -------------------------------------------------------
    let output = await probe(row.outputFilePath);
    if (output) {
      stats.probedOutput += 1;
    } else if (video && video.filePath === row.outputFilePath) {
      output = factsFromVideoRow(video);
      stats.fromVideoRow += 1;
    }
    output ??= { ...EMPTY_FACTS };

    // --- source side -------------------------------------------------------
    let source = await probe(row.sourceFilePath);
    if (source) {
      stats.probedSource += 1;
    } else if (video && video.filePath === row.sourceFilePath) {
      source = factsFromVideoRow(video);
      stats.fromVideoRow += 1;
    }

    const duration = row.durationSeconds ?? output.durationSeconds ?? null;

    if (!source) {
      // The source is gone. Frame rate always survives conversion, and when no
      // scale filter ran the output dimensions are the source dimensions.
      const unscaled =
        row.targetResolution === null || row.targetResolution === "original";

      source = {
        ...EMPTY_FACTS,
        width: unscaled ? output.width : null,
        height: unscaled ? output.height : null,
        fps: output.fps,
        durationSeconds: duration,
      };

      if (unscaled && output.width) {
        stats.inferredSourceDims += 1;
      }
    }

    const sourceBitrate =
      source.bitrate ?? deriveBitrate(row.originalSizeBytes, duration);
    const outputBitrate =
      output.bitrate ?? deriveBitrate(row.outputSizeBytes, duration);

    if (source.bitrate === null && sourceBitrate !== null) {
      stats.derivedSourceBitrate += 1;
    }

    // Only fill gaps — never overwrite metadata captured at conversion time.
    const update = {
      durationSeconds: row.durationSeconds ?? duration,
      sourceWidth: row.sourceWidth ?? source.width,
      sourceHeight: row.sourceHeight ?? source.height,
      sourceFps: row.sourceFps ?? source.fps,
      sourceCodec: row.sourceCodec ?? source.codec,
      sourceAudioCodec: row.sourceAudioCodec ?? source.audioCodec,
      sourceBitrate: row.sourceBitrate ?? sourceBitrate,
      outputWidth: row.outputWidth ?? output.width,
      outputHeight: row.outputHeight ?? output.height,
      outputFps: row.outputFps ?? output.fps,
      outputCodec: row.outputCodec ?? output.codec,
      outputAudioCodec: row.outputAudioCodec ?? output.audioCodec,
      outputBitrate: row.outputBitrate ?? outputBitrate,
    };

    const hasAnything = Object.values(update).some((value) => value !== null);

    if (!hasAnything) {
      stats.noDataAvailable += 1;
      continue;
    }

    if (!dryRun) {
      await db
        .update(conversionHistoryTable)
        .set(update)
        .where(eq(conversionHistoryTable.id, row.id));
    }

    stats.updated += 1;

    if (stats.scanned % 100 === 0) {
      console.log(`  …${stats.scanned}/${candidates.length}`);
    }
  }

  console.log("\nDone.");
  console.table(stats);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Backfill failed:", error);
    process.exit(1);
  });
