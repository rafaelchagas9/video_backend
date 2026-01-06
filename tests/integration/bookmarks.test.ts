import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import type { FastifyInstance } from 'fastify';
import { resolve } from 'path';
import {
  setupTestServer,
  cleanupTestServer,
  cleanupDatabase,
  createTestUser,
} from '../helpers/test-utils';

describe('Bookmarks', () => {
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

  it('should create a bookmark for a video', async () => {
    const response = await server.inject({
      method: 'POST',
      url: `/api/videos/${videoId}/bookmarks`,
      headers: { cookie: sessionCookie },
      payload: {
        timestamp_seconds: 120.5,
        name: 'Favorite scene',
        description: 'The best part',
      },
    });

    expect(response.statusCode).toBe(201);
    const data = JSON.parse(response.body);
    expect(data.data.timestamp_seconds).toBe(120.5);
    expect(data.data.name).toBe('Favorite scene');
    expect(data.data.description).toBe('The best part');
  });

  it('should get bookmarks for a video', async () => {
    // Create two bookmarks
    await server.inject({
      method: 'POST',
      url: `/api/videos/${videoId}/bookmarks`,
      headers: { cookie: sessionCookie },
      payload: { timestamp_seconds: 60, name: 'First bookmark' },
    });
    await server.inject({
      method: 'POST',
      url: `/api/videos/${videoId}/bookmarks`,
      headers: { cookie: sessionCookie },
      payload: { timestamp_seconds: 120, name: 'Second bookmark' },
    });

    const response = await server.inject({
      method: 'GET',
      url: `/api/videos/${videoId}/bookmarks`,
      headers: { cookie: sessionCookie },
    });

    expect(response.statusCode).toBe(200);
    const data = JSON.parse(response.body);
    expect(data.data.length).toBe(2);
    // Should be ordered by timestamp
    expect(data.data[0].timestamp_seconds).toBe(60);
    expect(data.data[1].timestamp_seconds).toBe(120);
  });

  it('should update a bookmark', async () => {
    const createResponse = await server.inject({
      method: 'POST',
      url: `/api/videos/${videoId}/bookmarks`,
      headers: { cookie: sessionCookie },
      payload: { timestamp_seconds: 100, name: 'Original name' },
    });
    const bookmarkId = JSON.parse(createResponse.body).data.id;

    const response = await server.inject({
      method: 'PATCH',
      url: `/api/bookmarks/${bookmarkId}`,
      headers: { cookie: sessionCookie },
      payload: {
        timestamp_seconds: 150,
        name: 'Updated name',
        description: 'New description',
      },
    });

    expect(response.statusCode).toBe(200);
    const data = JSON.parse(response.body);
    expect(data.data.timestamp_seconds).toBe(150);
    expect(data.data.name).toBe('Updated name');
    expect(data.data.description).toBe('New description');
  });

  it('should delete a bookmark', async () => {
    const createResponse = await server.inject({
      method: 'POST',
      url: `/api/videos/${videoId}/bookmarks`,
      headers: { cookie: sessionCookie },
      payload: { timestamp_seconds: 100, name: 'To delete' },
    });
    const bookmarkId = JSON.parse(createResponse.body).data.id;

    const response = await server.inject({
      method: 'DELETE',
      url: `/api/bookmarks/${bookmarkId}`,
      headers: { cookie: sessionCookie },
    });

    expect(response.statusCode).toBe(200);

    // Verify deletion
    const listResponse = await server.inject({
      method: 'GET',
      url: `/api/videos/${videoId}/bookmarks`,
      headers: { cookie: sessionCookie },
    });
    expect(JSON.parse(listResponse.body).data.length).toBe(0);
  });

  it('should validate bookmark timestamp is non-negative', async () => {
    const response = await server.inject({
      method: 'POST',
      url: `/api/videos/${videoId}/bookmarks`,
      headers: { cookie: sessionCookie },
      payload: { timestamp_seconds: -10, name: 'Invalid' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('should require bookmark name', async () => {
    const response = await server.inject({
      method: 'POST',
      url: `/api/videos/${videoId}/bookmarks`,
      headers: { cookie: sessionCookie },
      payload: { timestamp_seconds: 100 }, // Missing name
    });

    expect(response.statusCode).toBe(400);
  });
});
