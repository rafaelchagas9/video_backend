import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import type { FastifyInstance } from 'fastify';
import { resolve } from 'path';
import {
  setupTestServer,
  cleanupTestServer,
  cleanupDatabase,
  createTestUser,
} from '../helpers/test-utils';

describe('Videos', () => {
  let server: FastifyInstance;
  let sessionCookie: string;

  beforeAll(async () => {
    server = await setupTestServer();
  });

  afterAll(async () => {
    await cleanupTestServer(server);
  });

  beforeEach(async () => {
    cleanupDatabase();
    const auth = await createTestUser(server);
    sessionCookie = auth.sessionCookie;
  });

  describe('Video indexing with special characters', () => {
    it('should index video with special characters in filename', async () => {
      const testPath = resolve(process.cwd(), 'tests/videos');

      // Register directory and wait for indexing
      const createResponse = await server.inject({
        method: 'POST',
        url: '/api/directories',
        headers: {
          cookie: sessionCookie,
        },
        payload: {
          path: testPath,
          auto_scan: true,
          scan_interval_minutes: 30,
        },
      });

      expect(createResponse.statusCode).toBe(201);

      // Wait for indexing to complete
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // List videos
      const response = await server.inject({
        method: 'GET',
        url: '/api/videos',
        headers: {
          cookie: sessionCookie,
        },
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.success).toBe(true);
      expect(data.data.length).toBeGreaterThan(0);

      // Find the video with special characters
      const specialVideo = data.data.find((v: any) =>
        v.file_name.includes('DUPÊ')
      );

      expect(specialVideo).toBeDefined();
      expect(specialVideo.file_name).toBe(
        'DUPÊ - Cangaço Sessions Vol.3 [0hhPuRS-p9I].mp4'
      );
      expect(specialVideo.file_path).toContain('DUPÊ');
      expect(specialVideo.file_size_bytes).toBeGreaterThan(0);

      // Check that metadata was extracted
      expect(specialVideo.duration_seconds).toBeGreaterThan(0);
      expect(specialVideo.width).toBeGreaterThan(0);
      expect(specialVideo.height).toBeGreaterThan(0);
      expect(specialVideo.codec).toBeDefined();
    });
  });

  describe('GET /api/videos', () => {
    beforeEach(async () => {
      // Index test videos
      const testPath = resolve(process.cwd(), 'tests/videos');

      await server.inject({
        method: 'POST',
        url: '/api/directories',
        headers: {
          cookie: sessionCookie,
        },
        payload: {
          path: testPath,
          auto_scan: true,
          scan_interval_minutes: 30,
        },
      });

      // Wait for indexing
      await new Promise((resolve) => setTimeout(resolve, 3000));
    });

    it('should list all videos with pagination', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/api/videos?page=1&limit=10',
        headers: {
          cookie: sessionCookie,
        },
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.success).toBe(true);
      expect(Array.isArray(data.data)).toBe(true);
      expect(data.pagination).toBeDefined();
      expect(data.pagination.page).toBe(1);
      expect(data.pagination.limit).toBe(10);
      expect(data.pagination.total).toBeGreaterThan(0);
    });

    it('should search videos by filename', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/api/videos?search=DUPÊ',
        headers: {
          cookie: sessionCookie,
        },
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.success).toBe(true);
      expect(data.data.length).toBeGreaterThan(0);
      expect(data.data[0].file_name).toContain('DUPÊ');
    });

    it('should filter by directory', async () => {
      // Get directory ID
      const dirResponse = await server.inject({
        method: 'GET',
        url: '/api/directories',
        headers: {
          cookie: sessionCookie,
        },
      });

      const dirData = JSON.parse(dirResponse.body);
      const directoryId = dirData.data[0].id;

      const response = await server.inject({
        method: 'GET',
        url: `/api/videos?directory_id=${directoryId}`,
        headers: {
          cookie: sessionCookie,
        },
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.success).toBe(true);
      expect(data.data.every((v: any) => v.directory_id === directoryId)).toBe(
        true
      );
    });

    it('should sort videos', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/api/videos?sort=file_size_bytes&order=desc',
        headers: {
          cookie: sessionCookie,
        },
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.success).toBe(true);

      // Check if sorted in descending order
      if (data.data.length > 1) {
        for (let i = 0; i < data.data.length - 1; i++) {
          expect(data.data[i].file_size_bytes).toBeGreaterThanOrEqual(
            data.data[i + 1].file_size_bytes
          );
        }
      }
    });
  });

  describe('GET /api/videos/:id', () => {
    it('should get video by ID', async () => {
      const testPath = resolve(process.cwd(), 'tests/videos');

      await server.inject({
        method: 'POST',
        url: '/api/directories',
        headers: {
          cookie: sessionCookie,
        },
        payload: {
          path: testPath,
          auto_scan: true,
          scan_interval_minutes: 30,
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 3000));

      // Get first video
      const listResponse = await server.inject({
        method: 'GET',
        url: '/api/videos',
        headers: {
          cookie: sessionCookie,
        },
      });

      const listData = JSON.parse(listResponse.body);
      const videoId = listData.data[0].id;

      const response = await server.inject({
        method: 'GET',
        url: `/api/videos/${videoId}`,
        headers: {
          cookie: sessionCookie,
        },
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.success).toBe(true);
      expect(data.data.id).toBe(videoId);
    });

    it('should return 404 for non-existent video', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/api/videos/999999',
        headers: {
          cookie: sessionCookie,
        },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('PATCH /api/videos/:id', () => {
    it('should update video metadata', async () => {
      const testPath = resolve(process.cwd(), 'tests/videos');

      await server.inject({
        method: 'POST',
        url: '/api/directories',
        headers: {
          cookie: sessionCookie,
        },
        payload: {
          path: testPath,
          auto_scan: true,
          scan_interval_minutes: 30,
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 3000));

      const listResponse = await server.inject({
        method: 'GET',
        url: '/api/videos',
        headers: {
          cookie: sessionCookie,
        },
      });

      const listData = JSON.parse(listResponse.body);
      const videoId = listData.data[0].id;

      const response = await server.inject({
        method: 'PATCH',
        url: `/api/videos/${videoId}`,
        headers: {
          cookie: sessionCookie,
        },
        payload: {
          title: 'Test Video Title',
          description: 'This is a test video with special characters',
          themes: 'music, session',
        },
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.success).toBe(true);
      expect(data.data.title).toBe('Test Video Title');
      expect(data.data.description).toBe(
        'This is a test video with special characters'
      );
      expect(data.data.themes).toBe('music, session');
    });
  });

  describe('DELETE /api/videos/:id', () => {
    it('should delete a video', async () => {
      const testPath = resolve(process.cwd(), 'tests/videos');

      await server.inject({
        method: 'POST',
        url: '/api/directories',
        headers: {
          cookie: sessionCookie,
        },
        payload: {
          path: testPath,
          auto_scan: true,
          scan_interval_minutes: 30,
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 3000));

      const listResponse = await server.inject({
        method: 'GET',
        url: '/api/videos',
        headers: {
          cookie: sessionCookie,
        },
      });

      const listData = JSON.parse(listResponse.body);
      const videoId = listData.data[0].id;

      const response = await server.inject({
        method: 'DELETE',
        url: `/api/videos/${videoId}`,
        headers: {
          cookie: sessionCookie,
        },
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.success).toBe(true);

      // Verify deletion
      const getResponse = await server.inject({
        method: 'GET',
        url: `/api/videos/${videoId}`,
        headers: {
          cookie: sessionCookie,
        },
      });

      expect(getResponse.statusCode).toBe(404);
    });
  });

  describe('POST /api/videos/:id/verify', () => {
    it('should verify video availability', async () => {
      const testPath = resolve(process.cwd(), 'tests/videos');

      await server.inject({
        method: 'POST',
        url: '/api/directories',
        headers: {
          cookie: sessionCookie,
        },
        payload: {
          path: testPath,
          auto_scan: true,
          scan_interval_minutes: 30,
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 3000));

      const listResponse = await server.inject({
        method: 'GET',
        url: '/api/videos',
        headers: {
          cookie: sessionCookie,
        },
      });

      const listData = JSON.parse(listResponse.body);
      const videoId = listData.data[0].id;

      const response = await server.inject({
        method: 'POST',
        url: `/api/videos/${videoId}/verify`,
        headers: {
          cookie: sessionCookie,
        },
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.success).toBe(true);
      expect(data.data.is_available).toBe(1);
      expect(data.data.last_verified_at).toBeDefined();
    });
  });

  describe('GET /api/videos/:id/stream', () => {
    let videoId: number;

    beforeEach(async () => {
      const testPath = resolve(process.cwd(), 'tests/videos');

      await server.inject({
        method: 'POST',
        url: '/api/directories',
        headers: {
          cookie: sessionCookie,
        },
        payload: {
          path: testPath,
          auto_scan: true,
          scan_interval_minutes: 30,
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 3000));

      const listResponse = await server.inject({
        method: 'GET',
        url: '/api/videos',
        headers: {
          cookie: sessionCookie,
        },
      });

      const listData = JSON.parse(listResponse.body);
      videoId = listData.data[0].id;
    });

    it('should stream full video without Range header', async () => {
      const response = await server.inject({
        method: 'GET',
        url: `/api/videos/${videoId}/stream`,
        headers: {
          cookie: sessionCookie,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('video/mp4');
      expect(response.headers['accept-ranges']).toBe('bytes');
      expect(parseInt(response.headers['content-length'] as string)).toBeGreaterThan(0);
    });

    it('should return 206 Partial Content with Range header', async () => {
      const response = await server.inject({
        method: 'GET',
        url: `/api/videos/${videoId}/stream`,
        headers: {
          cookie: sessionCookie,
          range: 'bytes=0-1023',
        },
      });

      expect(response.statusCode).toBe(206);
      expect(response.headers['content-type']).toBe('video/mp4');
      expect(response.headers['accept-ranges']).toBe('bytes');
      expect(response.headers['content-range']).toMatch(/^bytes 0-1023\/\d+$/);
      expect(parseInt(response.headers['content-length'] as string)).toBe(1024);
    });

    it('should handle open-ended Range header', async () => {
      const response = await server.inject({
        method: 'GET',
        url: `/api/videos/${videoId}/stream`,
        headers: {
          cookie: sessionCookie,
          range: 'bytes=1000-',
        },
      });

      expect(response.statusCode).toBe(206);
      expect(response.headers['content-range']).toMatch(/^bytes 1000-\d+\/\d+$/);
    });

    it('should return 404 for non-existent video', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/api/videos/999999/stream',
        headers: {
          cookie: sessionCookie,
        },
      });

      expect(response.statusCode).toBe(404);
    });

    it('should return 416 for invalid Range', async () => {
      // First get the file size
      const infoResponse = await server.inject({
        method: 'GET',
        url: `/api/videos/${videoId}`,
        headers: {
          cookie: sessionCookie,
        },
      });
      const videoInfo = JSON.parse(infoResponse.body);
      const fileSize = videoInfo.data.file_size_bytes;

      // Request beyond file size
      const response = await server.inject({
        method: 'GET',
        url: `/api/videos/${videoId}/stream`,
        headers: {
          cookie: sessionCookie,
          range: `bytes=${fileSize + 1000}-${fileSize + 2000}`,
        },
      });

      expect(response.statusCode).toBe(416);
    });
  });
});
