import { createHash } from 'crypto';
import { createReadStream, existsSync } from 'fs';
import { stat } from 'fs/promises';
import { extname } from 'path';
import { SUPPORTED_VIDEO_FORMATS, HASH_ALGORITHM } from '@/config/constants';

export function isVideoFile(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  return SUPPORTED_VIDEO_FORMATS.includes(ext as any);
}

export async function getFileSize(filePath: string): Promise<number> {
  const stats = await stat(filePath);
  return stats.size;
}

export async function computeFileHash(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash(HASH_ALGORITHM);
    const stream = createReadStream(filePath);

    stream.on('data', (data) => hash.update(data));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
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
