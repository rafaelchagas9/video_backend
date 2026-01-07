import { describe, it, expect } from 'bun:test';
import { writeFile, unlink, mkdir } from 'fs/promises';
import { join } from 'path';
import { computeFileHash, isVideoFile, getFileSize, formatBytes } from '@/utils/file-utils';

const TEST_DIR = join(import.meta.dir, '../temp');

describe('file-utils', () => {
  describe('isVideoFile', () => {
    it('should identify video files by extension', () => {
      expect(isVideoFile('video.mp4')).toBe(true);
      expect(isVideoFile('video.mkv')).toBe(true);
      expect(isVideoFile('video.avi')).toBe(true);
      expect(isVideoFile('video.mov')).toBe(true);
      expect(isVideoFile('video.wmv')).toBe(true);
      expect(isVideoFile('video.flv')).toBe(true);
      expect(isVideoFile('video.webm')).toBe(true);
      expect(isVideoFile('video.m4v')).toBe(true);
    });

    it('should reject non-video files', () => {
      expect(isVideoFile('document.txt')).toBe(false);
      expect(isVideoFile('image.jpg')).toBe(false);
      expect(isVideoFile('audio.mp3')).toBe(false);
    });

    it('should be case insensitive', () => {
      expect(isVideoFile('VIDEO.MP4')).toBe(true);
      expect(isVideoFile('Video.MKV')).toBe(true);
    });
  });

  describe('formatBytes', () => {
    it('should format bytes correctly', () => {
      expect(formatBytes(0)).toBe('0 Bytes');
      expect(formatBytes(1024)).toBe('1 KB');
      expect(formatBytes(1024 * 1024)).toBe('1 MB');
      expect(formatBytes(1024 * 1024 * 1024)).toBe('1 GB');
      expect(formatBytes(1536)).toBe('1.5 KB');
    });
  });

  describe('computeFileHash', () => {
    it('should compute consistent hash for small files (<2GB)', async () => {
      await mkdir(TEST_DIR, { recursive: true });
      const testFile = join(TEST_DIR, 'small-test.txt');
      const content = 'Hello, World!';
      
      try {
        await writeFile(testFile, content);
        
        const hash1 = await computeFileHash(testFile);
        const hash2 = await computeFileHash(testFile);
        
        // Same file should produce same hash
        expect(hash1).toBe(hash2);
        expect(hash1).toBeTruthy();
        expect(hash1.length).toBe(64); // SHA256 = 64 hex chars
      } finally {
        await unlink(testFile);
      }
    });

    it('should detect file changes in small files', async () => {
      await mkdir(TEST_DIR, { recursive: true });
      const testFile = join(TEST_DIR, 'change-test.txt');
      
      try {
        await writeFile(testFile, 'Content 1');
        const hash1 = await computeFileHash(testFile);
        
        await writeFile(testFile, 'Content 2');
        const hash2 = await computeFileHash(testFile);
        
        // Different content should produce different hash
        expect(hash1).not.toBe(hash2);
      } finally {
        await unlink(testFile);
      }
    });

    it('should use full hash for files under 2GB', async () => {
      await mkdir(TEST_DIR, { recursive: true });
      const testFile = join(TEST_DIR, 'medium-test.bin');
      
      try {
        // Create a 10MB file (well under 2GB threshold)
        const size = 10 * 1024 * 1024; // 10MB
        const buffer = Buffer.alloc(size, 'a');
        await writeFile(testFile, buffer);
        
        const fileSize = await getFileSize(testFile);
        expect(fileSize).toBe(size);
        
        const hash = await computeFileHash(testFile);
        expect(hash).toBeTruthy();
        expect(hash.length).toBe(64);
      } finally {
        await unlink(testFile);
      }
    });

    // Note: Testing partial hash for >2GB files would be too slow for unit tests
    // This should be tested manually or in integration tests with actual large files
  });
});
