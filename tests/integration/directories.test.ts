import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import type { FastifyInstance } from 'fastify';
import { resolve } from 'path';
import {
  setupTestServer,
  cleanupTestServer,
  cleanupDatabase,
  createTestUser,
} from '../helpers/test-utils';

describe('Directories', () => {
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

  describe('POST /api/directories', () => {
    it('should register a valid directory', async () => {
      const testPath = resolve(process.cwd(), 'tests/videos');

      const response = await server.inject({
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

      expect(response.statusCode).toBe(201);
      const data = JSON.parse(response.body);
      expect(data.success).toBe(true);
      expect(data.data.path).toBe(testPath);
      expect(data.data.auto_scan).toBe(1);
      expect(data.data.scan_interval_minutes).toBe(30);
      expect(data.message).toContain('Scanning started');
    });

    it('should fail with non-existent directory', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/directories',
        headers: {
          cookie: sessionCookie,
        },
        payload: {
          path: '/path/that/does/not/exist',
          auto_scan: true,
          scan_interval_minutes: 30,
        },
      });

      expect(response.statusCode).toBe(400);
      const data = JSON.parse(response.body);
      expect(data.success).toBe(false);
      expect(data.error.message).toContain('does not exist');
    });

    it('should prevent duplicate directory registration', async () => {
      const testPath = resolve(process.cwd(), 'tests/videos');

      // First registration
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

      // Attempt duplicate
      const response = await server.inject({
        method: 'POST',
        url: '/api/directories',
        headers: {
          cookie: sessionCookie,
        },
        payload: {
          path: testPath,
          auto_scan: false,
          scan_interval_minutes: 60,
        },
      });

      expect(response.statusCode).toBe(409);
      const data = JSON.parse(response.body);
      expect(data.success).toBe(false);
      expect(data.error.message).toContain('already registered');
    });

    it('should require authentication', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/directories',
        payload: {
          path: '/tmp',
          auto_scan: true,
          scan_interval_minutes: 30,
        },
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('GET /api/directories', () => {
    it('should list all registered directories', async () => {
      const testPath = resolve(process.cwd(), 'tests/videos');

      // Register a directory
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

      // List directories
      const response = await server.inject({
        method: 'GET',
        url: '/api/directories',
        headers: {
          cookie: sessionCookie,
        },
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.success).toBe(true);
      expect(Array.isArray(data.data)).toBe(true);
      expect(data.data.length).toBe(1);
      expect(data.data[0].path).toBe(testPath);
    });

    it('should return empty array when no directories registered', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/api/directories',
        headers: {
          cookie: sessionCookie,
        },
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.success).toBe(true);
      expect(data.data).toEqual([]);
    });
  });

  describe('GET /api/directories/:id', () => {
    it('should get directory by ID', async () => {
      const testPath = resolve(process.cwd(), 'tests/videos');

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

      const createData = JSON.parse(createResponse.body);
      const directoryId = createData.data.id;

      const response = await server.inject({
        method: 'GET',
        url: `/api/directories/${directoryId}`,
        headers: {
          cookie: sessionCookie,
        },
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.success).toBe(true);
      expect(data.data.id).toBe(directoryId);
      expect(data.data.path).toBe(testPath);
    });

    it('should return 404 for non-existent directory', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/api/directories/999',
        headers: {
          cookie: sessionCookie,
        },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('PATCH /api/directories/:id', () => {
    it('should update directory settings', async () => {
      const testPath = resolve(process.cwd(), 'tests/videos');

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

      const createData = JSON.parse(createResponse.body);
      const directoryId = createData.data.id;

      const response = await server.inject({
        method: 'PATCH',
        url: `/api/directories/${directoryId}`,
        headers: {
          cookie: sessionCookie,
        },
        payload: {
          auto_scan: false,
          scan_interval_minutes: 60,
        },
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.success).toBe(true);
      expect(data.data.auto_scan).toBe(0);
      expect(data.data.scan_interval_minutes).toBe(60);
    });
  });

  describe('DELETE /api/directories/:id', () => {
    it('should delete a directory', async () => {
      const testPath = resolve(process.cwd(), 'tests/videos');

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

      const createData = JSON.parse(createResponse.body);
      const directoryId = createData.data.id;

      const response = await server.inject({
        method: 'DELETE',
        url: `/api/directories/${directoryId}`,
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
        url: `/api/directories/${directoryId}`,
        headers: {
          cookie: sessionCookie,
        },
      });

      expect(getResponse.statusCode).toBe(404);
    });
  });

  describe('GET /api/directories/:id/stats', () => {
    it('should return directory statistics', async () => {
      const testPath = resolve(process.cwd(), 'tests/videos');

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

      const createData = JSON.parse(createResponse.body);
      const directoryId = createData.data.id;

      // Wait for scan to complete
      await new Promise((resolve) => setTimeout(resolve, 2000));

      const response = await server.inject({
        method: 'GET',
        url: `/api/directories/${directoryId}/stats`,
        headers: {
          cookie: sessionCookie,
        },
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.success).toBe(true);
      expect(data.data).toHaveProperty('directory_id');
      expect(data.data).toHaveProperty('total_videos');
      expect(data.data).toHaveProperty('total_size_bytes');
      expect(data.data).toHaveProperty('available_videos');
      expect(data.data).toHaveProperty('unavailable_videos');
    });
  });

  describe('POST /api/directories/:id/scan', () => {
    it('should trigger manual scan', async () => {
      const testPath = resolve(process.cwd(), 'tests/videos');

      const createResponse = await server.inject({
        method: 'POST',
        url: '/api/directories',
        headers: {
          cookie: sessionCookie,
        },
        payload: {
          path: testPath,
          auto_scan: false,
          scan_interval_minutes: 30,
        },
      });

      const createData = JSON.parse(createResponse.body);
      const directoryId = createData.data.id;

      const response = await server.inject({
        method: 'POST',
        url: `/api/directories/${directoryId}/scan`,
        headers: {
          cookie: sessionCookie,
        },
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.success).toBe(true);
      expect(data.message).toContain('scan started');
    });
  });
});
