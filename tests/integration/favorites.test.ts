import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import type { FastifyInstance } from 'fastify';
import { resolve } from 'path';
import {
  setupTestServer,
  cleanupTestServer,
  cleanupDatabase,
  createTestUser,
} from '../helpers/test-utils';

describe('Favorites', () => {
  let server: FastifyInstance;
  let sessionCookie: string;
  let videoId: number;

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

    // Index a video for testing
    const testPath = resolve(process.cwd(), 'tests/videos');
    await server.inject({
      method: 'POST',
      url: '/api/directories',
      headers: { cookie: sessionCookie },
      payload: { path: testPath, auto_scan: true },
    });
    // Wait for scan
    await new Promise(r => setTimeout(r, 1000));
    
    const videos = await server.inject({
      method: 'GET',
      url: '/api/videos',
      headers: { cookie: sessionCookie },
    });
    videoId = JSON.parse(videos.body).data[0].id;
  });

  it('should add video to favorites', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/favorites',
      headers: { cookie: sessionCookie },
      payload: { video_id: videoId },
    });

    expect(response.statusCode).toBe(201);
  });

  it('should be idempotent when adding same favorite twice', async () => {
    await server.inject({
      method: 'POST',
      url: '/api/favorites',
      headers: { cookie: sessionCookie },
      payload: { video_id: videoId },
    });

    const response = await server.inject({
      method: 'POST',
      url: '/api/favorites',
      headers: { cookie: sessionCookie },
      payload: { video_id: videoId },
    });

    expect(response.statusCode).toBe(201); // Should succeed (idempotent)
  });

  it('should list favorited videos', async () => {
    await server.inject({
      method: 'POST',
      url: '/api/favorites',
      headers: { cookie: sessionCookie },
      payload: { video_id: videoId },
    });

    const response = await server.inject({
      method: 'GET',
      url: '/api/favorites',
      headers: { cookie: sessionCookie },
    });

    expect(response.statusCode).toBe(200);
    const data = JSON.parse(response.body);
    expect(data.data.length).toBe(1);
    expect(data.data[0].id).toBe(videoId);
  });

  it('should check if video is favorited', async () => {
    await server.inject({
      method: 'POST',
      url: '/api/favorites',
      headers: { cookie: sessionCookie },
      payload: { video_id: videoId },
    });

    const response = await server.inject({
      method: 'GET',
      url: `/api/favorites/${videoId}/check`,
      headers: { cookie: sessionCookie },
    });

    expect(response.statusCode).toBe(200);
    const data = JSON.parse(response.body);
    expect(data.data.is_favorite).toBe(true);
  });

  it('should return false when checking non-favorited video', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/api/favorites/${videoId}/check`,
      headers: { cookie: sessionCookie },
    });

    expect(response.statusCode).toBe(200);
    const data = JSON.parse(response.body);
    expect(data.data.is_favorite).toBe(false);
  });

  it('should remove video from favorites', async () => {
    await server.inject({
      method: 'POST',
      url: '/api/favorites',
      headers: { cookie: sessionCookie },
      payload: { video_id: videoId },
    });

    const response = await server.inject({
      method: 'DELETE',
      url: `/api/favorites/${videoId}`,
      headers: { cookie: sessionCookie },
    });

    expect(response.statusCode).toBe(200);

    // Verify removal
    const listResponse = await server.inject({
      method: 'GET',
      url: '/api/favorites',
      headers: { cookie: sessionCookie },
    });
    expect(JSON.parse(listResponse.body).data.length).toBe(0);
  });

  it('should return 404 when removing non-favorited video', async () => {
    const response = await server.inject({
      method: 'DELETE',
      url: `/api/favorites/${videoId}`,
      headers: { cookie: sessionCookie },
    });

    expect(response.statusCode).toBe(404);
  });
});
