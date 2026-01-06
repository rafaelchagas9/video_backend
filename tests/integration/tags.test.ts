import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import type { FastifyInstance } from 'fastify';
import { resolve } from 'path';
import {
  setupTestServer,
  cleanupTestServer,
  cleanupDatabase,
  createTestUser,
} from '../helpers/test-utils';

describe('Tags', () => {
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
    it('should create a new tag', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/tags',
        headers: { cookie: sessionCookie },
        payload: {
          name: 'Action',
          description: 'Action videos',
        },
      });

      expect(response.statusCode).toBe(201);
      const data = JSON.parse(response.body);
      expect(data.success).toBe(true);
      expect(data.data.name).toBe('Action');
    });

    it('should create hierarchical tags', async () => {
      // Create parent
      const parentResponse = await server.inject({
        method: 'POST',
        url: '/api/tags',
        headers: { cookie: sessionCookie },
        payload: { name: 'Genre' },
      });
      const parentId = JSON.parse(parentResponse.body).data.id;

      // Create child
      const childResponse = await server.inject({
        method: 'POST',
        url: '/api/tags',
        headers: { cookie: sessionCookie },
        payload: { name: 'Action', parent_id: parentId },
      });
      expect(childResponse.statusCode).toBe(201);
      const childData = JSON.parse(childResponse.body).data;
      expect(childData.parent_id).toBe(parentId);
    });

    it('should get tag with path', async () => {
      // Create hierarchy: Genre > Action > Sci-Fi
      const genreResponse = await server.inject({
        method: 'POST',
        url: '/api/tags',
        headers: { cookie: sessionCookie },
        payload: { name: 'Genre' },
      });
      const genreId = JSON.parse(genreResponse.body).data.id;

      const actionResponse = await server.inject({
        method: 'POST',
        url: '/api/tags',
        headers: { cookie: sessionCookie },
        payload: { name: 'Action', parent_id: genreId },
      });
      const actionId = JSON.parse(actionResponse.body).data.id;

      const scifiResponse = await server.inject({
        method: 'POST',
        url: '/api/tags',
        headers: { cookie: sessionCookie },
        payload: { name: 'Sci-Fi', parent_id: actionId },
      });
      const scifiId = JSON.parse(scifiResponse.body).data.id;

      // Get tag with path
      const response = await server.inject({
        method: 'GET',
        url: `/api/tags/${scifiId}`,
        headers: { cookie: sessionCookie },
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.data.path).toBe('Genre > Action > Sci-Fi');
    });

    it('should get children of a tag', async () => {
      const parentResponse = await server.inject({
        method: 'POST',
        url: '/api/tags',
        headers: { cookie: sessionCookie },
        payload: { name: 'Parent' },
      });
      const parentId = JSON.parse(parentResponse.body).data.id;

      await server.inject({
        method: 'POST',
        url: '/api/tags',
        headers: { cookie: sessionCookie },
        payload: { name: 'Child 1', parent_id: parentId },
      });
      await server.inject({
        method: 'POST',
        url: '/api/tags',
        headers: { cookie: sessionCookie },
        payload: { name: 'Child 2', parent_id: parentId },
      });

      const response = await server.inject({
        method: 'GET',
        url: `/api/tags/${parentId}/children`,
        headers: { cookie: sessionCookie },
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.data.length).toBe(2);
    });

    it('should get tags as tree', async () => {
      const parentResponse = await server.inject({
        method: 'POST',
        url: '/api/tags',
        headers: { cookie: sessionCookie },
        payload: { name: 'Root' },
      });
      const rootId = JSON.parse(parentResponse.body).data.id;

      await server.inject({
        method: 'POST',
        url: '/api/tags',
        headers: { cookie: sessionCookie },
        payload: { name: 'Branch', parent_id: rootId },
      });

      const response = await server.inject({
        method: 'GET',
        url: '/api/tags?tree=true',
        headers: { cookie: sessionCookie },
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.data[0].children).toBeDefined();
      expect(data.data[0].children.length).toBe(1);
    });

    it('should delete tag with cascade', async () => {
      const parentResponse = await server.inject({
        method: 'POST',
        url: '/api/tags',
        headers: { cookie: sessionCookie },
        payload: { name: 'To Delete' },
      });
      const parentId = JSON.parse(parentResponse.body).data.id;

      const childResponse = await server.inject({
        method: 'POST',
        url: '/api/tags',
        headers: { cookie: sessionCookie },
        payload: { name: 'Child', parent_id: parentId },
      });
      const childId = JSON.parse(childResponse.body).data.id;

      await server.inject({
        method: 'DELETE',
        url: `/api/tags/${parentId}`,
        headers: { cookie: sessionCookie },
      });

      // Child should also be deleted
      const getChild = await server.inject({
        method: 'GET',
        url: `/api/tags/${childId}`,
        headers: { cookie: sessionCookie },
      });
      expect(getChild.statusCode).toBe(404);
    });
  });

  describe('Video Associations', () => {
    it('should associate tag with video', async () => {
      // Create tag
      const tagResponse = await server.inject({
        method: 'POST',
        url: '/api/tags',
        headers: { cookie: sessionCookie },
        payload: { name: 'Music' },
      });
      const tagId = JSON.parse(tagResponse.body).data.id;

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

      // Add tag to video
      const addResponse = await server.inject({
        method: 'POST',
        url: `/api/videos/${videoId}/tags`,
        headers: { cookie: sessionCookie },
        payload: { tag_id: tagId },
      });
      expect(addResponse.statusCode).toBe(201);

      // Get tags for video
      const getResponse = await server.inject({
        method: 'GET',
        url: `/api/videos/${videoId}/tags`,
        headers: { cookie: sessionCookie },
      });
      const tags = JSON.parse(getResponse.body).data;
      expect(tags.length).toBe(1);
      expect(tags[0].id).toBe(tagId);
    });
  });
});
