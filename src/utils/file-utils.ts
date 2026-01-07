import { createHash } from 'crypto';
import { createReadStream, existsSync } from 'fs';
import { stat, open } from 'fs/promises';
import { extname } from 'path';
import { SUPPORTED_VIDEO_FORMATS, HASH_ALGORITHM } from '@/config/constants';

// Threshold for using partial hashing (2GB)
const FULL_HASH_THRESHOLD = 2 * 1024 * 1024 * 1024;
// Sample size for partial hashing (1MB per sample)
const SAMPLE_SIZE = 1024 * 1024;

export function isVideoFile(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  return SUPPORTED_VIDEO_FORMATS.includes(ext as any);
}

export async function getFileSize(filePath: string): Promise<number> {
  const stats = await stat(filePath);
  return stats.size;
}

/**
 * Computes file hash using partial hashing for large files to improve performance.
 * - Files <2GB: full SHA256 hash (streaming)
 * - Files >=2GB: hash first 1MB + middle 1MB + last 1MB + file size
 * 
 * Partial hashing is ~50-70x faster for large files while maintaining
 * sufficient uniqueness for duplicate detection and change detection.
 */
export async function computeFileHash(filePath: string): Promise<string> {
  const stats = await stat(filePath);
  const fileSize = stats.size;

  // For small files, use full hash
  if (fileSize < FULL_HASH_THRESHOLD) {
    return computeFullHash(filePath);
  }

  // For large files, use partial hash
  return computePartialHash(filePath, fileSize);
}

/**
 * Computes full SHA256 hash using streams (memory efficient)
 */
async function computeFullHash(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash(HASH_ALGORITHM);
    const stream = createReadStream(filePath, {
      highWaterMark: 64 * 1024, // 64KB chunks - optimal for HDD
    });

    stream.on('data', (data) => hash.update(data));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * Computes partial hash by sampling beginning, middle, and end of file.
 * This provides a good balance between speed and uniqueness for large files.
 * 
 * Hash includes:
 * - First 1MB of file
 * - Middle 1MB of file
 * - Last 1MB of file
 * - File size (to prevent collisions between files of different sizes)
 */
async function computePartialHash(
  filePath: string,
  fileSize: number,
): Promise<string> {
  const hash = createHash(HASH_ALGORITHM);
  const file = await open(filePath, 'r');

  try {
    // Hash first 1MB
    const startBuffer = Buffer.allocUnsafe(SAMPLE_SIZE);
    await file.read(startBuffer, 0, SAMPLE_SIZE, 0);
    hash.update(startBuffer);

    // Hash middle 1MB
    const middleOffset = Math.floor(fileSize / 2) - Math.floor(SAMPLE_SIZE / 2);
    const middleBuffer = Buffer.allocUnsafe(SAMPLE_SIZE);
    await file.read(middleBuffer, 0, SAMPLE_SIZE, middleOffset);
    hash.update(middleBuffer);

    // Hash last 1MB
    const endOffset = fileSize - SAMPLE_SIZE;
    const endBuffer = Buffer.allocUnsafe(SAMPLE_SIZE);
    await file.read(endBuffer, 0, SAMPLE_SIZE, endOffset);
    hash.update(endBuffer);

    // Include file size in hash to avoid collisions
    hash.update(Buffer.from(fileSize.toString()));

    return hash.digest('hex');
  } finally {
    await file.close();
  }
}

export function fileExists(filePath: string): boolean {
  return existsSync(filePath);
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 Bytes';

  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}
