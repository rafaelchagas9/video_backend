import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import type { FastifyInstance } from 'fastify';
import {
  setupTestServer,
  cleanupTestServer,
  cleanupDatabase,
} from '../helpers/test-utils';

describe('Authentication', () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = await setupTestServer();
  });

  afterAll(async () => {
    await cleanupTestServer(server);
  });

  beforeEach(() => {
    cleanupDatabase();
  });

  describe('POST /api/auth/register', () => {
    it('should register a new user successfully', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          username: 'testuser',
          password: 'testpass123',
        },
      });

      expect(response.statusCode).toBe(201);
      const data = JSON.parse(response.body);
      expect(data.success).toBe(true);
      expect(data.data.username).toBe('testuser');
      expect(data.data.id).toBeDefined();
    });

    it('should fail with short username', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          username: 'ab',
          password: 'testpass123',
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should fail with short password', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          username: 'testuser',
          password: 'short',
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should prevent duplicate registration', async () => {
      // First registration
      await server.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          username: 'testuser',
          password: 'testpass123',
        },
      });

      // Attempt duplicate registration
      const response = await server.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          username: 'anotheruser',
          password: 'anotherpass123',
        },
      });

      expect(response.statusCode).toBe(409);
      const data = JSON.parse(response.body);
      expect(data.success).toBe(false);
      expect(data.error.message).toContain('already exists');
    });
  });

  describe('POST /api/auth/login', () => {
    beforeEach(async () => {
      // Create a test user
      await server.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          username: 'testuser',
          password: 'testpass123',
        },
      });
    });

    it('should login successfully with valid credentials', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {
          username: 'testuser',
          password: 'testpass123',
        },
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.success).toBe(true);
      expect(data.data.username).toBe('testuser');

      // Check for session cookie
      const cookies = response.cookies;
      const sessionCookie = cookies.find((c: any) => c.name === 'session_id');
      expect(sessionCookie).toBeDefined();
      expect(sessionCookie?.value).toBeDefined();
    });

    it('should fail with invalid password', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {
          username: 'testuser',
          password: 'wrongpassword',
        },
      });

      expect(response.statusCode).toBe(401);
    });

    it('should fail with non-existent user', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {
          username: 'nonexistent',
          password: 'testpass123',
        },
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('GET /api/auth/me', () => {
    it('should return current user when authenticated', async () => {
      // Register and login
      await server.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          username: 'testuser',
          password: 'testpass123',
        },
      });

      const loginResponse = await server.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {
          username: 'testuser',
          password: 'testpass123',
        },
      });

      const cookies = loginResponse.cookies;
      const sessionCookie = cookies.find((c: any) => c.name === 'session_id');

      // Get current user
      const response = await server.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: {
          cookie: `${sessionCookie?.name}=${sessionCookie?.value}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.success).toBe(true);
      expect(data.data.username).toBe('testuser');
    });

    it('should fail when not authenticated', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/api/auth/me',
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('POST /api/auth/logout', () => {
    it('should logout successfully', async () => {
      // Register and login
      await server.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          username: 'testuser',
          password: 'testpass123',
        },
      });

      const loginResponse = await server.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {
          username: 'testuser',
          password: 'testpass123',
        },
      });

      const cookies = loginResponse.cookies;
      const sessionCookie = cookies.find((c: any) => c.name === 'session_id');

      // Logout
      const response = await server.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: {
          cookie: `${sessionCookie?.name}=${sessionCookie?.value}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.success).toBe(true);

      // Try to access protected route with old session
      const meResponse = await server.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: {
          cookie: `${sessionCookie?.name}=${sessionCookie?.value}`,
        },
      });

      expect(meResponse.statusCode).toBe(401);
    });
  });
});
