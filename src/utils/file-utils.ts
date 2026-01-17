import { xxh3 } from "@node-rs/xxhash";
import { createReadStream, existsSync } from "fs";
import { stat, open } from "fs/promises";
import { extname } from "path";
import { SUPPORTED_VIDEO_FORMATS } from "@/config/constants";

// Threshold for using partial hashing (10MB)
const FULL_HASH_THRESHOLD = 10 * 1024 * 1024;
// Sample size for partial hashing (4MB per sample for better HDD performance)
const SAMPLE_SIZE = 4 * 1024 * 1024;

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
 * Uses XXH3-128 (128-bit xxHash3) for extremely fast hashing with low collision probability.
 *
 * - Files <10MB: full XXH3-64 hash (streaming, memory efficient)
 * - Files >=10MB: partial XXH3-128 hash (first 4MB + middle 4MB + last 4MB + file size)
 *
 * Partial hashing is ~50-100x faster for large files while maintaining
 * sufficient uniqueness for duplicate detection and change detection.
 * Collision detection is handled at the service layer (uses full XXH3-64 hash).
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
 * Computes full XXH3-64 hash for a file using true streaming.
 * Exported for collision detection - when partial 128-bit hashes collide,
 * this function computes a full 64-bit hash for disambiguation.
 * Using 64-bit after a 128-bit collision is extremely safe (negligible collision probability).
 */
export { computeFullHash };

/**
 * Computes full XXH3-64 hash using true streaming (supports files >4GB, memory efficient)
 *
 * Note: Uses 64-bit XXH3 instead of 128-bit because @node-rs/xxhash's Xxh3 streaming
 * class only supports 64-bit output. This is acceptable for collision resolution because:
 * - This function is only called when partial 128-bit hashes already collided (extremely rare)
 * - The probability of a 64-bit collision AFTER a partial 128-bit collision is negligible
 * - Enables true streaming with no memory limits (critical for files >4GB)
 */
async function computeFullHash(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Create streaming hasher for 64-bit hash
    const hasher = xxh3.Xxh3.withSeed(0n);

    const stream = createReadStream(filePath, {
      highWaterMark: 256 * 1024, // 256KB chunks - optimal for HDD with xxHash
    });

    stream.on("data", (chunk) => {
      // Update hasher with each chunk (no buffering needed)
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hasher.update(buffer);
    });

    stream.on("end", () => {
      // Get final 64-bit hash as BigInt
      const hash = hasher.digest();
      // Convert bigint to hex string (16 characters for 64-bit)
      // Pad to 32 chars to match database field expectations
      resolve(hash.toString(16).padStart(32, "0"));
    });

    stream.on("error", reject);
  });
}

/**
 * Computes partial hash by sampling beginning, middle, and end of file.
 * This provides a good balance between speed and uniqueness for large files.
 *
 * Hash includes:
 * - First 4MB of file
 * - Middle 4MB of file
 * - Last 4MB of file
 * - File size (to prevent collisions between files of different sizes)
 */
async function computePartialHash(
  filePath: string,
  fileSize: number,
): Promise<string> {
  const file = await open(filePath, "r");

  try {
    // Read first 4MB
    const startBuffer = Buffer.allocUnsafe(SAMPLE_SIZE);
    await file.read(startBuffer, 0, SAMPLE_SIZE, 0);

    // Read middle 4MB
    const middleOffset = Math.floor(fileSize / 2) - Math.floor(SAMPLE_SIZE / 2);
    const middleBuffer = Buffer.allocUnsafe(SAMPLE_SIZE);
    await file.read(middleBuffer, 0, SAMPLE_SIZE, middleOffset);

    // Read last 4MB
    const endOffset = fileSize - SAMPLE_SIZE;
    const endBuffer = Buffer.allocUnsafe(SAMPLE_SIZE);
    await file.read(endBuffer, 0, SAMPLE_SIZE, endOffset);

    // Combine all samples and file size
    const combinedBuffer = Buffer.concat([
      startBuffer,
      middleBuffer,
      endBuffer,
      Buffer.from(fileSize.toString()),
    ]);

    // Compute XXH3-128 hash
    const hash = xxh3.xxh128(combinedBuffer);
    // Convert bigint to hex string (32 characters for 128-bit)
    return hash.toString(16).padStart(32, "0");
  } finally {
    await file.close();
  }
}

export function fileExists(filePath: string): boolean {
  return existsSync(filePath);
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 Bytes";

  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}
