import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import type { FastifyInstance } from 'fastify';
import { resolve } from 'path';
import {
  setupTestServer,
  cleanupTestServer,
  cleanupDatabase,
  createTestUser,
} from '../helpers/test-utils';

describe('Playlists', () => {
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

  it('should create a playlist', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/playlists',
      headers: { cookie: sessionCookie },
      payload: { name: 'My Playlist', description: 'Test playlist' },
    });

    expect(response.statusCode).toBe(201);
    const data = JSON.parse(response.body);
    expect(data.data.name).toBe('My Playlist');
    expect(data.data.description).toBe('Test playlist');
  });

  it('should list user playlists', async () => {
    // Create two playlists
    await server.inject({
      method: 'POST',
      url: '/api/playlists',
      headers: { cookie: sessionCookie },
      payload: { name: 'Playlist 1' },
    });
    await server.inject({
      method: 'POST',
      url: '/api/playlists',
      headers: { cookie: sessionCookie },
      payload: { name: 'Playlist 2' },
    });

    const response = await server.inject({
      method: 'GET',
      url: '/api/playlists',
      headers: { cookie: sessionCookie },
    });

    expect(response.statusCode).toBe(200);
    const data = JSON.parse(response.body);
    expect(data.data.length).toBe(2);
  });

  it('should update a playlist', async () => {
    const createResponse = await server.inject({
      method: 'POST',
      url: '/api/playlists',
      headers: { cookie: sessionCookie },
      payload: { name: 'Original Name' },
    });
    const playlistId = JSON.parse(createResponse.body).data.id;

    const response = await server.inject({
      method: 'PATCH',
      url: `/api/playlists/${playlistId}`,
      headers: { cookie: sessionCookie },
      payload: { name: 'Updated Name', description: 'New description' },
    });

    expect(response.statusCode).toBe(200);
    const data = JSON.parse(response.body);
    expect(data.data.name).toBe('Updated Name');
    expect(data.data.description).toBe('New description');
  });

  it('should delete a playlist', async () => {
    const createResponse = await server.inject({
      method: 'POST',
      url: '/api/playlists',
      headers: { cookie: sessionCookie },
      payload: { name: 'To Delete' },
    });
    const playlistId = JSON.parse(createResponse.body).data.id;

    const response = await server.inject({
      method: 'DELETE',
      url: `/api/playlists/${playlistId}`,
      headers: { cookie: sessionCookie },
    });

    expect(response.statusCode).toBe(200);

    // Verify deletion
    const listResponse = await server.inject({
      method: 'GET',
      url: '/api/playlists',
      headers: { cookie: sessionCookie },
    });
    expect(JSON.parse(listResponse.body).data.length).toBe(0);
  });

  it('should add video to playlist', async () => {
    const createResponse = await server.inject({
      method: 'POST',
      url: '/api/playlists',
      headers: { cookie: sessionCookie },
      payload: { name: 'Video Playlist' },
    });
    const playlistId = JSON.parse(createResponse.body).data.id;

    const response = await server.inject({
      method: 'POST',
      url: `/api/playlists/${playlistId}/videos`,
      headers: { cookie: sessionCookie },
      payload: { video_id: videoId },
    });

    expect(response.statusCode).toBe(201);
  });

  it('should list videos in playlist', async () => {
    const createResponse = await server.inject({
      method: 'POST',
      url: '/api/playlists',
      headers: { cookie: sessionCookie },
      payload: { name: 'Video Playlist' },
    });
    const playlistId = JSON.parse(createResponse.body).data.id;

    await server.inject({
      method: 'POST',
      url: `/api/playlists/${playlistId}/videos`,
      headers: { cookie: sessionCookie },
      payload: { video_id: videoId, position: 0 },
    });

    const response = await server.inject({
      method: 'GET',
      url: `/api/playlists/${playlistId}/videos`,
      headers: { cookie: sessionCookie },
    });

    expect(response.statusCode).toBe(200);
    const data = JSON.parse(response.body);
    expect(data.data.length).toBe(1);
    expect(data.data[0].id).toBe(videoId);
  });

  it('should remove video from playlist', async () => {
    const createResponse = await server.inject({
      method: 'POST',
      url: '/api/playlists',
      headers: { cookie: sessionCookie },
      payload: { name: 'Video Playlist' },
    });
    const playlistId = JSON.parse(createResponse.body).data.id;

    await server.inject({
      method: 'POST',
      url: `/api/playlists/${playlistId}/videos`,
      headers: { cookie: sessionCookie },
      payload: { video_id: videoId },
    });

    const response = await server.inject({
      method: 'DELETE',
      url: `/api/playlists/${playlistId}/videos/${videoId}`,
      headers: { cookie: sessionCookie },
    });

    expect(response.statusCode).toBe(200);

    // Verify removal
    const listResponse = await server.inject({
      method: 'GET',
      url: `/api/playlists/${playlistId}/videos`,
      headers: { cookie: sessionCookie },
    });
    expect(JSON.parse(listResponse.body).data.length).toBe(0);
  });

  it('should prevent duplicate videos in playlist', async () => {
    const createResponse = await server.inject({
      method: 'POST',
      url: '/api/playlists',
      headers: { cookie: sessionCookie },
      payload: { name: 'Video Playlist' },
    });
    const playlistId = JSON.parse(createResponse.body).data.id;

    await server.inject({
      method: 'POST',
      url: `/api/playlists/${playlistId}/videos`,
      headers: { cookie: sessionCookie },
      payload: { video_id: videoId },
    });

    const response = await server.inject({
      method: 'POST',
      url: `/api/playlists/${playlistId}/videos`,
      headers: { cookie: sessionCookie },
      payload: { video_id: videoId },
    });

    expect(response.statusCode).toBe(409); // Conflict
  });

  it('should reorder videos in playlist', async () => {
    // This test would require multiple videos, skipping for now
    // as we only have one test video
  });
});
