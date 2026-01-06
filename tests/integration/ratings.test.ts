import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import type { FastifyInstance } from 'fastify';
import { resolve } from 'path';
import {
  setupTestServer,
  cleanupTestServer,
  cleanupDatabase,
  createTestUser,
} from '../helpers/test-utils';

describe('Ratings', () => {
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

  it('should add a rating to a video', async () => {
    const response = await server.inject({
      method: 'POST',
      url: `/api/videos/${videoId}/ratings`,
      headers: { cookie: sessionCookie },
      payload: { rating: 5, comment: 'Great video!' },
    });

    expect(response.statusCode).toBe(201);
    const data = JSON.parse(response.body);
    expect(data.data.rating).toBe(5);
    expect(data.data.comment).toBe('Great video!');
  });

  it('should get ratings and average for a video', async () => {
    // Add two ratings
    await server.inject({
      method: 'POST',
      url: `/api/videos/${videoId}/ratings`,
      headers: { cookie: sessionCookie },
      payload: { rating: 4 },
    });
    await server.inject({
      method: 'POST',
      url: `/api/videos/${videoId}/ratings`,
      headers: { cookie: sessionCookie },
      payload: { rating: 2 },
    });

    const response = await server.inject({
      method: 'GET',
      url: `/api/videos/${videoId}/ratings`,
      headers: { cookie: sessionCookie },
    });

    expect(response.statusCode).toBe(200);
    const data = JSON.parse(response.body);
    expect(data.data.length).toBe(2);
    expect(data.average).toBe(3); // (4+2)/2
  });

  it('should update a rating', async () => {
    const createResponse = await server.inject({
      method: 'POST',
      url: `/api/videos/${videoId}/ratings`,
      headers: { cookie: sessionCookie },
      payload: { rating: 3, comment: 'Okay' },
    });
    const ratingId = JSON.parse(createResponse.body).data.id;

    const response = await server.inject({
      method: 'PATCH',
      url: `/api/ratings/${ratingId}`,
      headers: { cookie: sessionCookie },
      payload: { rating: 5, comment: 'Better now' },
    });

    expect(response.statusCode).toBe(200);
    const data = JSON.parse(response.body);
    expect(data.data.rating).toBe(5);
    expect(data.data.comment).toBe('Better now');
  });

  it('should delete a rating', async () => {
    const createResponse = await server.inject({
      method: 'POST',
      url: `/api/videos/${videoId}/ratings`,
      headers: { cookie: sessionCookie },
      payload: { rating: 1 },
    });
    const ratingId = JSON.parse(createResponse.body).data.id;

    const response = await server.inject({
      method: 'DELETE',
      url: `/api/ratings/${ratingId}`,
      headers: { cookie: sessionCookie },
    });

    expect(response.statusCode).toBe(200);

    // Verify deletion
    const listResponse = await server.inject({
      method: 'GET',
      url: `/api/videos/${videoId}/ratings`,
      headers: { cookie: sessionCookie },
    });
    expect(JSON.parse(listResponse.body).data.length).toBe(0);
  });

  it('should validate rating range (1-5)', async () => {
    const response = await server.inject({
      method: 'POST',
      url: `/api/videos/${videoId}/ratings`,
      headers: { cookie: sessionCookie },
      payload: { rating: 6 }, // Invalid
    });

    expect(response.statusCode).toBe(400);
  });
});
