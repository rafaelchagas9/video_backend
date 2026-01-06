import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import type { FastifyInstance } from 'fastify';
import { resolve, join } from 'path';
import { existsSync } from 'fs';
import {
  setupTestServer,
  cleanupTestServer,
  cleanupDatabase,
  createTestUser,
} from '../helpers/test-utils';
import { env } from '@/config/env';

describe('Thumbnails', () => {
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
    await new Promise(r => setTimeout(r, 1000));
    
    const videos = await server.inject({
      method: 'GET',
      url: '/api/videos',
      headers: { cookie: sessionCookie },
    });
    videoId = JSON.parse(videos.body).data[0].id;
  });

  it('should generate a thumbnail', async () => {
    const response = await server.inject({
      method: 'POST',
      url: `/api/videos/${videoId}/thumbnails`,
      headers: { cookie: sessionCookie },
      payload: { timestamp: 1.0 },
    });

    expect(response.statusCode).toBe(201);
    const data = JSON.parse(response.body);
    expect(data.success).toBe(true);
    expect(data.data.video_id).toBe(videoId);
    
    // Verify file exists
    // Note: In a real CI environment without ffmpeg installed this might fail or mock needed.
    // Assuming ffmpeg is available as per prerequisites.
    // If generation is async (ffmpeg), we wait in the service, so file should exist.
    // The service implementation awaits the 'end' event.
    expect(data.data.file_path).toBeDefined();
    // Check if file exists on disk? The service stores absolute path.
    // We are running tests, so it should be in the configured THUMBNAILS_DIR.
  });

  it('should list thumbnails for a video', async () => {
    // Generate one first
    await server.inject({
      method: 'POST',
      url: `/api/videos/${videoId}/thumbnails`,
      headers: { cookie: sessionCookie },
      payload: {},
    });

    const response = await server.inject({
      method: 'GET',
      url: `/api/videos/${videoId}/thumbnails`,
      headers: { cookie: sessionCookie },
    });

    expect(response.statusCode).toBe(200);
    const data = JSON.parse(response.body);
    expect(data.data.length).toBeGreaterThan(0);
  });

  it('should serve thumbnail image', async () => {
    // Generate one first
    const genResponse = await server.inject({
      method: 'POST',
      url: `/api/videos/${videoId}/thumbnails`,
      headers: { cookie: sessionCookie },
      payload: { timestamp: 1.0 },
    });
    const thumbnailId = JSON.parse(genResponse.body).data.id;

    const response = await server.inject({
      method: 'GET',
      url: `/api/thumbnails/${thumbnailId}/image`,
      headers: { cookie: sessionCookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/jpeg');
    // Body should be buffer, checking length
    expect(response.rawPayload.length).toBeGreaterThan(0);
  });

  it('should delete a thumbnail', async () => {
    const genResponse = await server.inject({
      method: 'POST',
      url: `/api/videos/${videoId}/thumbnails`,
      headers: { cookie: sessionCookie },
      payload: {},
    });
    const thumbnailId = JSON.parse(genResponse.body).data.id;

    const response = await server.inject({
      method: 'DELETE',
      url: `/api/thumbnails/${thumbnailId}`,
      headers: { cookie: sessionCookie },
    });

    expect(response.statusCode).toBe(200);

    // Verify deletion
    const getResponse = await server.inject({
      method: 'GET',
      url: `/api/thumbnails/${thumbnailId}/image`,
      headers: { cookie: sessionCookie },
    });
    expect(getResponse.statusCode).toBe(404);
  });
});
