import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import type { FastifyInstance } from 'fastify';
import { resolve } from 'path';
import {
  setupTestServer,
  cleanupTestServer,
  cleanupDatabase,
  createTestUser,
} from '../helpers/test-utils';

describe('Creators', () => {
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

  describe('CRUD Operations', () => {
    it('should create a new creator', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/creators',
        headers: { cookie: sessionCookie },
        payload: {
          name: 'Test Creator',
          description: 'A test creator',
        },
      });

      expect(response.statusCode).toBe(201);
      const data = JSON.parse(response.body);
      expect(data.success).toBe(true);
      expect(data.data.name).toBe('Test Creator');
      expect(data.data.description).toBe('A test creator');
    });

    it('should list all creators', async () => {
      // Create two creators
      await server.inject({
        method: 'POST',
        url: '/api/creators',
        headers: { cookie: sessionCookie },
        payload: { name: 'Creator A' },
      });
      await server.inject({
        method: 'POST',
        url: '/api/creators',
        headers: { cookie: sessionCookie },
        payload: { name: 'Creator B' },
      });

      const response = await server.inject({
        method: 'GET',
        url: '/api/creators',
        headers: { cookie: sessionCookie },
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.data.length).toBe(2);
    });

    it('should update a creator', async () => {
      const createResponse = await server.inject({
        method: 'POST',
        url: '/api/creators',
        headers: { cookie: sessionCookie },
        payload: { name: 'Original Name' },
      });
      const creatorId = JSON.parse(createResponse.body).data.id;

      const response = await server.inject({
        method: 'PATCH',
        url: `/api/creators/${creatorId}`,
        headers: { cookie: sessionCookie },
        payload: { name: 'Updated Name' },
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.data.name).toBe('Updated Name');
    });

    it('should delete a creator', async () => {
      const createResponse = await server.inject({
        method: 'POST',
        url: '/api/creators',
        headers: { cookie: sessionCookie },
        payload: { name: 'To Delete' },
      });
      const creatorId = JSON.parse(createResponse.body).data.id;

      const response = await server.inject({
        method: 'DELETE',
        url: `/api/creators/${creatorId}`,
        headers: { cookie: sessionCookie },
      });

      expect(response.statusCode).toBe(200);

      // Verify deletion
      const getResponse = await server.inject({
        method: 'GET',
        url: `/api/creators/${creatorId}`,
        headers: { cookie: sessionCookie },
      });
      expect(getResponse.statusCode).toBe(404);
    });

    it('should return 409 for duplicate name', async () => {
      await server.inject({
        method: 'POST',
        url: '/api/creators',
        headers: { cookie: sessionCookie },
        payload: { name: 'Unique Name' },
      });

      const response = await server.inject({
        method: 'POST',
        url: '/api/creators',
        headers: { cookie: sessionCookie },
        payload: { name: 'Unique Name' },
      });

      expect(response.statusCode).toBe(409);
    });
  });

  describe('Video Associations', () => {
    it('should associate creator with video', async () => {
      // Create creator
      const creatorResponse = await server.inject({
        method: 'POST',
        url: '/api/creators',
        headers: { cookie: sessionCookie },
        payload: { name: 'Video Creator' },
      });
      const creatorId = JSON.parse(creatorResponse.body).data.id;

      // Index video
      const testPath = resolve(process.cwd(), 'tests/videos');
      await server.inject({
        method: 'POST',
        url: '/api/directories',
        headers: { cookie: sessionCookie },
        payload: { path: testPath, auto_scan: true, scan_interval_minutes: 30 },
      });
      await new Promise((r) => setTimeout(r, 3000));

      const videosResponse = await server.inject({
        method: 'GET',
        url: '/api/videos',
        headers: { cookie: sessionCookie },
      });
      const videoId = JSON.parse(videosResponse.body).data[0].id;

      // Add creator to video
      const addResponse = await server.inject({
        method: 'POST',
        url: `/api/videos/${videoId}/creators`,
        headers: { cookie: sessionCookie },
        payload: { creator_id: creatorId },
      });
      expect(addResponse.statusCode).toBe(201);

      // Get creators for video
      const getResponse = await server.inject({
        method: 'GET',
        url: `/api/videos/${videoId}/creators`,
        headers: { cookie: sessionCookie },
      });
      const creators = JSON.parse(getResponse.body).data;
      expect(creators.length).toBe(1);
      expect(creators[0].id).toBe(creatorId);

      // Get videos for creator
      const videosForCreator = await server.inject({
        method: 'GET',
        url: `/api/creators/${creatorId}/videos`,
        headers: { cookie: sessionCookie },
      });
      expect(JSON.parse(videosForCreator.body).data.length).toBe(1);
    });
  });
});
