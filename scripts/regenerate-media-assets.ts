#!/usr/bin/env bun
/**
 * Regenerate media assets with current env settings.
 *
 * Usage:
 *   bun scripts/regenerate-media-assets.ts [options]
 *
 * Options:
 *   --storyboards         Regenerate existing storyboards
 *   --thumbnails          Regenerate existing thumbnails
 *   --profile-pictures    Re-encode creator and studio profile pictures
 *   --all                 Run all of the above
 *   --dry-run             Print what would be processed
 *   --limit <n>           Limit number of records per section
 *   --offset <n>          Offset for pagination per section
 *   --help, -h            Show this help message
 */

import {
  existsSync,
  mkdirSync,
  unlinkSync,
  writeFileSync,
  readFileSync,
} from "fs";
import { join } from "path";
import { and, isNotNull, eq } from "drizzle-orm";
import { db } from "../src/config/drizzle";
import {
  creatorsTable,
  studiosTable,
  storyboardsTable,
  thumbnailsTable,
} from "../src/database/schema";
import { env } from "../src/config/env";
import { storyboardsService } from "../src/modules/storyboards/storyboards.service";
import { thumbnailsService } from "../src/modules/thumbnails/thumbnails.service";
import { processProfilePicture } from "../src/utils/image-processing";
import { logger } from "../src/utils/logger";

const argv = process.argv.slice(2);
const helpRequested = argv.includes("--help") || argv.includes("-h");

const useAll = argv.includes("--all");
const requestedStoryboards = argv.includes("--storyboards");
const requestedThumbnails = argv.includes("--thumbnails");
const requestedProfiles = argv.includes("--profile-pictures");

const dryRun = argv.includes("--dry-run");

const getArgValue = (flag: string): string | null => {
  const index = argv.indexOf(flag);
  if (index === -1) return null;
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
};

const limitValue = getArgValue("--limit");
const offsetValue = getArgValue("--offset");
const limit = limitValue ? Number.parseInt(limitValue, 10) : null;
const offset = offsetValue ? Number.parseInt(offsetValue, 10) : null;

const shouldRunStoryboards =
  useAll ||
  requestedStoryboards ||
  (!requestedStoryboards && !requestedThumbnails && !requestedProfiles);
const shouldRunThumbnails =
  useAll ||
  requestedThumbnails ||
  (!requestedStoryboards && !requestedThumbnails && !requestedProfiles);
const shouldRunProfiles =
  useAll ||
  requestedProfiles ||
  (!requestedStoryboards && !requestedThumbnails && !requestedProfiles);

if (helpRequested) {
  console.log(`Usage: bun scripts/regenerate-media-assets.ts [options]

Options:
  --storyboards         Regenerate existing storyboards
  --thumbnails          Regenerate existing thumbnails
  --profile-pictures    Re-encode creator and studio profile pictures
  --all                 Run all of the above
  --dry-run             Print what would be processed
  --limit <n>           Limit number of records per section
  --offset <n>          Offset for pagination per section
  --help, -h            Show this help message
`);
  process.exit(0);
}

const ensureProfileDir = () => {
  if (!existsSync(env.PROFILE_PICTURES_DIR)) {
    mkdirSync(env.PROFILE_PICTURES_DIR, { recursive: true });
  }
};

const applyLimitOffset = <T>(items: T[]): T[] => {
  if (offset && offset > 0) {
    items = items.slice(offset);
  }
  if (limit && limit > 0) {
    items = items.slice(0, limit);
  }
  return items;
};

async function regenerateStoryboards(): Promise<void> {
  const rows = await db
    .select({ videoId: storyboardsTable.videoId })
    .from(storyboardsTable)
    .orderBy(storyboardsTable.videoId);

  const targets: Array<{ videoId: number }> = applyLimitOffset(rows);

  console.log(
    `\nStoryboards: ${targets.length} item(s)${dryRun ? " (dry-run)" : ""}`,
  );

  for (const row of targets) {
    if (dryRun) {
      console.log(`[storyboard] video ${row.videoId}`);
      continue;
    }

    try {
      await storyboardsService.generate(row.videoId);
      console.log(`[storyboard] regenerated for video ${row.videoId}`);
    } catch (error) {
      const normalizedError =
        error instanceof Error ? error : new Error(String(error));
      logger.error(
        { error: normalizedError, videoId: row.videoId },
        "Failed to regenerate storyboard",
      );
    }
  }
}

async function regenerateThumbnails(): Promise<void> {
  const rows = await db
    .select({ videoId: thumbnailsTable.videoId })
    .from(thumbnailsTable)
    .orderBy(thumbnailsTable.videoId);

  const targets: Array<{ videoId: number }> = applyLimitOffset(rows);

  console.log(
    `\nThumbnails: ${targets.length} item(s)${dryRun ? " (dry-run)" : ""}`,
  );

  for (const row of targets) {
    if (dryRun) {
      console.log(`[thumbnail] video ${row.videoId}`);
      continue;
    }

    try {
      await thumbnailsService.generate(row.videoId);
      console.log(`[thumbnail] regenerated for video ${row.videoId}`);
    } catch (error) {
      const normalizedError =
        error instanceof Error ? error : new Error(String(error));
      logger.error(
        {
          videoId: row.videoId,
          errorMessage: normalizedError.message,
          errorStack: normalizedError.stack,
        },
        "Failed to regenerate thumbnail",
      );
    }
  }
}

async function regenerateCreatorProfilePictures(): Promise<void> {
  const rows = await db
    .select({ id: creatorsTable.id, path: creatorsTable.profilePicturePath })
    .from(creatorsTable)
    .where(and(isNotNull(creatorsTable.profilePicturePath)))
    .orderBy(creatorsTable.id);

  const targets: Array<{ id: number; path: string | null }> =
    applyLimitOffset(rows);

  console.log(
    `\nCreator profile pictures: ${targets.length} item(s)${dryRun ? " (dry-run)" : ""}`,
  );

  for (const creator of targets) {
    if (!creator.path || !existsSync(creator.path)) {
      console.log(`[creator] missing file for ${creator.id}`);
      continue;
    }

    if (dryRun) {
      console.log(`[creator] re-encode ${creator.id} -> ${creator.path}`);
      continue;
    }

    try {
      ensureProfileDir();

      const buffer = readFileSync(creator.path);
      const format = env.PROFILE_PICTURE_FORMAT;
      const quality = env.PROFILE_PICTURE_QUALITY;
      const maxSize = env.PROFILE_PICTURE_MAX_SIZE;
      const newFilename = `creator_${creator.id}_${Date.now()}.${format}`;
      const newPath = join(env.PROFILE_PICTURES_DIR, newFilename);

      const processed = await processProfilePicture({
        input: buffer,
        format,
        maxSize,
        quality,
      });

      writeFileSync(newPath, processed);

      await db
        .update(creatorsTable)
        .set({
          profilePicturePath: newPath,
          updatedAt: new Date(),
        })
        .where(eq(creatorsTable.id, creator.id));

      if (newPath !== creator.path && existsSync(creator.path)) {
        unlinkSync(creator.path);
      }

      console.log(`[creator] re-encoded ${creator.id}`);
    } catch (error) {
      const normalizedError =
        error instanceof Error ? error : new Error(String(error));
      logger.error(
        { error: normalizedError, creatorId: creator.id },
        "Failed to re-encode creator picture",
      );
    }
  }
}

async function regenerateStudioProfilePictures(): Promise<void> {
  const rows = await db
    .select({ id: studiosTable.id, path: studiosTable.profilePicturePath })
    .from(studiosTable)
    .where(and(isNotNull(studiosTable.profilePicturePath)))
    .orderBy(studiosTable.id);

  const targets: Array<{ id: number; path: string | null }> =
    applyLimitOffset(rows);

  console.log(
    `\nStudio profile pictures: ${targets.length} item(s)${dryRun ? " (dry-run)" : ""}`,
  );

  for (const studio of targets) {
    if (!studio.path || !existsSync(studio.path)) {
      console.log(`[studio] missing file for ${studio.id}`);
      continue;
    }

    if (dryRun) {
      console.log(`[studio] re-encode ${studio.id} -> ${studio.path}`);
      continue;
    }

    try {
      ensureProfileDir();

      const buffer = readFileSync(studio.path);
      const format = env.PROFILE_PICTURE_FORMAT;
      const quality = env.PROFILE_PICTURE_QUALITY;
      const maxSize = env.PROFILE_PICTURE_MAX_SIZE;
      const newFilename = `studio_${studio.id}_${Date.now()}.${format}`;
      const newPath = join(env.PROFILE_PICTURES_DIR, newFilename);

      const processed = await processProfilePicture({
        input: buffer,
        format,
        maxSize,
        quality,
      });

      writeFileSync(newPath, processed);

      await db
        .update(studiosTable)
        .set({
          profilePicturePath: newPath,
          updatedAt: new Date(),
        })
        .where(eq(studiosTable.id, studio.id));

      if (newPath !== studio.path && existsSync(studio.path)) {
        unlinkSync(studio.path);
      }

      console.log(`[studio] re-encoded ${studio.id}`);
    } catch (error) {
      const normalizedError =
        error instanceof Error ? error : new Error(String(error));
      logger.error(
        { error: normalizedError, studioId: studio.id },
        "Failed to re-encode studio picture",
      );
    }
  }
}

async function run(): Promise<void> {
  if (shouldRunStoryboards) {
    await regenerateStoryboards();
  }

  if (shouldRunThumbnails) {
    await regenerateThumbnails();
  }

  if (shouldRunProfiles) {
    await regenerateCreatorProfilePictures();
    await regenerateStudioProfilePictures();
  }

  console.log("\nDone.");
}

run().catch((error) => {
  console.error("\nFailed to regenerate assets:", error);
  process.exit(1);
});
