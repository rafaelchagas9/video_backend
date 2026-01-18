#!/usr/bin/env bun
/**
 * Migration Script: Creator Face Thumbnails & Embeddings
 *
 * Backfills cropped face thumbnails for existing creators who have profile pictures
 * but no face thumbnails. Optionally generates face recognition embeddings.
 *
 * Usage:
 *   bun scripts/migrate-creator-face-thumbnails.ts [OPTIONS]
 *
 * Options:
 *   --generate-embeddings  Also create face recognition embeddings
 *   --force               Regenerate existing thumbnails
 *   --dry-run             Preview without making changes
 *   --help, -h            Show this help message
 */

import { db } from '@/config/drizzle';
import { creatorsTable, creatorFaceEmbeddingsTable } from '@/database/schema';
import { isNotNull, isNull, and, eq } from 'drizzle-orm';
import { getFaceRecognitionClient } from '@/modules/face-recognition';
import { cropFaceThumbnail } from '@/utils/image-processing';
import { logger } from '@/utils/logger';
import { env } from '@/config/env';
import { existsSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';

// CLI Arguments
const args = {
  generateEmbeddings: process.argv.includes('--generate-embeddings'),
  force: process.argv.includes('--force'),
  dryRun: process.argv.includes('--dry-run'),
  help: process.argv.includes('--help') || process.argv.includes('-h'),
};

// Statistics tracking
interface MigrationStats {
  total: number;
  success: number;
  noFaceDetected: number;
  fileMissing: number;
  errors: number;
  embeddingsCreated: number;
  newPrimary: number;
  additional: number;
  noFaceDetectedIds: number[];
  errorIds: number[];
  noFaceDetectedPfpPaths: string[];
  errorPfpPaths: string[];
}

const stats: MigrationStats = {
  total: 0,
  success: 0,
  noFaceDetected: 0,
  fileMissing: 0,
  errors: 0,
  embeddingsCreated: 0,
  newPrimary: 0,
  additional: 0,
  noFaceDetectedIds: [],
  errorIds: [],
  noFaceDetectedPfpPaths: [],
  errorPfpPaths: [],
};

// Show help message
if (args.help) {
  console.log(`Usage: bun scripts/migrate-creator-face-thumbnails.ts [OPTIONS]

Options:
  --generate-embeddings  Also create face recognition embeddings
  --force               Regenerate existing thumbnails
  --dry-run             Preview without making changes
  --help, -h            Show this help message

Examples:
  # Basic usage - only generate missing face thumbnails
  bun scripts/migrate-creator-face-thumbnails.ts

  # Also generate face recognition embeddings
  bun scripts/migrate-creator-face-thumbnails.ts --generate-embeddings

  # Force regeneration of existing thumbnails
  bun scripts/migrate-creator-face-thumbnails.ts --force

  # Preview what would be processed
  bun scripts/migrate-creator-face-thumbnails.ts --dry-run
`);
  process.exit(0);
}

/**
 * Pre-flight checks to ensure service availability and directory structure
 */
async function preflightChecks(): Promise<boolean> {
  console.log('\n🔍 Running pre-flight checks...\n');

  // Check face recognition service
  console.log('Checking face recognition service availability...');
  const faceClient = getFaceRecognitionClient();

  const available = await faceClient.waitForAvailability(30000, 2000);

  if (!available) {
    console.error('❌ Face recognition service unavailable at:', env.FACE_SERVICE_URL);
    console.error('   Please ensure the service is running and try again.');
    return false;
  }

  console.log('✅ Face recognition service is available\n');

  // Ensure faces directory exists
  const faceDir = join(env.PROFILE_PICTURES_DIR, 'faces');
  if (!existsSync(faceDir)) {
    console.log(`Creating faces directory: ${faceDir}`);
    mkdirSync(faceDir, { recursive: true });
  }
  console.log('✅ Faces directory exists\n');

  return true;
}

/**
 * Process a single creator to generate face thumbnail and optional embedding
 */
async function processCreator(creator: {
  id: number;
  name: string;
  profilePicturePath: string;
}): Promise<void> {
  const startTime = Date.now();

  try {
    // Validate file exists
    if (!existsSync(creator.profilePicturePath)) {
      console.log(`📁 File missing for ${creator.name}`);
      stats.fileMissing++;
      logger.error({ creatorId: creator.id, path: creator.profilePicturePath }, 'Profile picture file not found');
      return;
    }

    // Detect faces in profile picture
    const faceClient = getFaceRecognitionClient();
    const result = await faceClient.detectFacesFromFile(creator.profilePicturePath);

    if (result.faces.length === 0) {
      console.log(`⚠️  No face detected for ${creator.name}`);
      stats.noFaceDetected++;
      stats.noFaceDetectedIds.push(creator.id);
      stats.noFaceDetectedPfpPaths.push(creator.profilePicturePath);
      logger.warn({ creatorId: creator.id }, 'No face detected in profile picture');
      return;
    }

    // Select best face (highest confidence)
    const bestFace = result.faces.reduce((best, current) =>
      current.det_score > best.det_score ? current : best,
    );

    if (result.faces.length > 1) {
      logger.info(
        { creatorId: creator.id, faceCount: result.faces.length, bestScore: bestFace.det_score },
        'Multiple faces detected, using highest confidence',
      );
    }

    // Generate face thumbnail filename
    const faceDir = join(env.PROFILE_PICTURES_DIR, 'faces');
    const faceFilename = `creator_${creator.id}_${Date.now()}_face.jpg`;
    const facePath = join(faceDir, faceFilename);

    if (!args.dryRun) {
      // Crop and save face thumbnail
      await cropFaceThumbnail({
        inputPath: creator.profilePicturePath,
        outputPath: facePath,
        faceBox: bestFace.bbox,
        imageWidth: result.image_width,
        imageHeight: result.image_height,
      });

      // Update database with face thumbnail path
      await db
        .update(creatorsTable)
        .set({
          faceThumbnailPath: facePath,
          updatedAt: new Date(),
        })
        .where(eq(creatorsTable.id, creator.id));

      logger.info({ creatorId: creator.id, facePath }, 'Face thumbnail generated');
    }

    // Generate face embedding if requested
    if (args.generateEmbeddings && !args.dryRun) {
      await generateFaceEmbedding(creator.id, facePath, bestFace);
    }

    const duration = Date.now() - startTime;
    console.log(`✅ ${creator.name} (${duration}ms)`);
    stats.success++;
  } catch (error) {
    console.log(`❌ Failed: ${creator.name} - ${error instanceof Error ? error.message : 'Unknown error'}`);
    stats.errors++;
    stats.errorIds.push(creator.id);
    stats.errorPfpPaths.push(creator.profilePicturePath);
    logger.error({ creatorId: creator.id, error }, 'Failed to process creator');
  }
}

/**
 * Generate face embedding from cropped face thumbnail
 */
async function generateFaceEmbedding(
  creatorId: number,
  facePath: string,
  faceData: any,
): Promise<void> {
  try {
    const faceClient = getFaceRecognitionClient();

    // Detect face in cropped thumbnail to get embedding
    const embeddingResult = await faceClient.detectFacesFromFile(facePath);

    if (embeddingResult.faces.length === 0) {
      logger.warn({ creatorId }, 'No face detected in cropped thumbnail for embedding');
      return;
    }

    const face = embeddingResult.faces[0];
    const embedding = JSON.stringify(face.embedding);

    // Check if creator has existing embeddings
    const existingEmbeddings = await db
      .select({ id: creatorFaceEmbeddingsTable.id })
      .from(creatorFaceEmbeddingsTable)
      .where(eq(creatorFaceEmbeddingsTable.creatorId, creatorId))
      .limit(1);

    const isPrimary = existingEmbeddings.length === 0;

    // If setting as primary, unset other primary embeddings
    if (isPrimary) {
      await db
        .update(creatorFaceEmbeddingsTable)
        .set({ isPrimary: false })
        .where(eq(creatorFaceEmbeddingsTable.creatorId, creatorId));
    }

    // Insert embedding
    await db.insert(creatorFaceEmbeddingsTable).values({
      creatorId,
      embedding,
      sourceType: 'profile_picture',
      detScore: face.det_score,
      isPrimary,
      estimatedAge: face.age,
      estimatedGender: face.gender,
    });

    stats.embeddingsCreated++;
    if (isPrimary) {
      stats.newPrimary++;
    } else {
      stats.additional++;
    }

    logger.info(
      { creatorId, isPrimary, detScore: face.det_score },
      'Face embedding created',
    );
  } catch (error) {
    logger.error({ creatorId, error }, 'Failed to generate face embedding');
  }
}

/**
 * Main migration execution
 */
async function runMigration(): Promise<void> {
  console.log('\n🚀 Creator Face Thumbnail Migration');
  console.log('=====================================\n');

  if (args.dryRun) {
    console.log('🔍 DRY RUN MODE - No changes will be made\n');
  }

  if (args.force) {
    console.log('⚡ FORCE MODE - Regenerating existing thumbnails\n');
  }

  if (args.generateEmbeddings) {
    console.log('🧠 EMBEDDINGS MODE - Generating face recognition embeddings\n');
  }

  // Pre-flight checks
  const checksPass = await preflightChecks();
  if (!checksPass) {
    process.exit(1);
  }

  // Query creators to migrate
  const query = args.force
    ? isNotNull(creatorsTable.profilePicturePath)
    : and(
        isNotNull(creatorsTable.profilePicturePath),
        isNull(creatorsTable.faceThumbnailPath)
      );

  const creatorsToMigrate = await db
    .select({
      id: creatorsTable.id,
      name: creatorsTable.name,
      profilePicturePath: creatorsTable.profilePicturePath,
    })
    .from(creatorsTable)
    .where(query);

  stats.total = creatorsToMigrate.length;

  if (stats.total === 0) {
    console.log('✅ No creators need migration. All done!\n');
    return;
  }

  console.log(`Found ${stats.total} creator(s) to process\n`);
  console.log('Processing creators...\n');

  // Process each creator
  for (let i = 0; i < creatorsToMigrate.length; i++) {
    const creator = creatorsToMigrate[i];
    const progress = ((i + 1) / stats.total * 100).toFixed(1);

    process.stdout.write(`[${i + 1}/${stats.total}] (${progress}%) `);

    // Filter out null profilePicturePath (TypeScript guard)
    if (creator.profilePicturePath) {
      await processCreator({
        id: creator.id,
        name: creator.name,
        profilePicturePath: creator.profilePicturePath,
      });
    }
  }

  // Print final summary
  printSummary();
}

/**
 * Print migration summary statistics
 */
function printSummary(): void {
  console.log('\n=====================================');
  console.log('       Migration Summary');
  console.log('=====================================\n');

  console.log(`Total Creators:       ${stats.total}`);
  console.log(`✅ Success:           ${stats.success} (${(stats.success / stats.total * 100).toFixed(1)}%)`);
  console.log(`⚠️  No Face Detected:  ${stats.noFaceDetected} (${(stats.noFaceDetected / stats.total * 100).toFixed(1)}%)`);
  console.log(`📁 File Missing:       ${stats.fileMissing} (${(stats.fileMissing / stats.total * 100).toFixed(1)}%)`);
  console.log(`❌ Errors:             ${stats.errors} (${(stats.errors / stats.total * 100).toFixed(1)}%)`);

  if (stats.noFaceDetectedIds.length > 0) {
    console.log(`\n⚠️  Creators with no face detected (${stats.noFaceDetectedIds.length}):`);
    stats.noFaceDetectedIds.forEach((id, index) => {
      console.log(`   [${id}] ${stats.noFaceDetectedPfpPaths[index]}`);
    });
  }

  if (stats.errorIds.length > 0) {
    console.log(`\n❌ Creators with errors (${stats.errorIds.length}):`);
    stats.errorIds.forEach((id, index) => {
      console.log(`   [${id}] ${stats.errorPfpPaths[index]}`);
    });
  }

  if (args.generateEmbeddings && !args.dryRun) {
    console.log(`\nFace Embeddings Created: ${stats.embeddingsCreated}`);
    console.log(`  - New Primary:         ${stats.newPrimary}`);
    console.log(`  - Additional:          ${stats.additional}`);
  }

  if (args.dryRun) {
    console.log('\n🔍 DRY RUN - No changes were made');
  }

  console.log('\n✅ Migration complete!\n');
}

// Run migration
runMigration()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Migration failed:', error);
    logger.error({ error }, 'Migration script failed');
    process.exit(1);
  });
