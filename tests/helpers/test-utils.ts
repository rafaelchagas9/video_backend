import type { FastifyInstance } from 'fastify';
import { buildServer } from '@/server';
import { getDatabase, closeDatabase } from '@/config/database';

export async function setupTestServer(): Promise<FastifyInstance> {
  const server = await buildServer();
  await server.ready();
  return server;
}

export async function cleanupTestServer(server: FastifyInstance): Promise<void> {
  await server.close();
  closeDatabase();
}

export function cleanupDatabase(): void {
  // Always get a fresh database reference to handle cases where it was closed
  const db = getDatabase();

  try {
    // Delete all data in reverse order of dependencies
    db.exec('DELETE FROM scan_logs');
    db.exec('DELETE FROM triage_progress');
    db.exec('DELETE FROM bookmarks');
    db.exec('DELETE FROM favorites');
    db.exec('DELETE FROM playlist_videos');
    db.exec('DELETE FROM playlists');
    db.exec('DELETE FROM thumbnails');
    db.exec('DELETE FROM video_metadata');
    db.exec('DELETE FROM ratings');
    db.exec('DELETE FROM video_tags');
    db.exec('DELETE FROM tags');
    db.exec('DELETE FROM video_creators');
    db.exec('DELETE FROM creators');
    db.exec('DELETE FROM videos');
    db.exec('DELETE FROM watched_directories');
    db.exec('DELETE FROM sessions');
    db.exec('DELETE FROM users');
  } catch (error) {
    // If cleanup fails, log and re-throw
    console.error('Failed to cleanup database:', error);
    throw error;
  }
}

export async function createTestUser(
  server: FastifyInstance,
  username = 'testuser',
  password = 'testpass123'
): Promise<{ userId: number; sessionCookie: string }> {
  // Register user
  const registerResponse = await server.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: {
      username,
      password,
    },
  });

  const registerData = JSON.parse(registerResponse.body);
  const userId = registerData.data.id;

  // Login to get session
  const loginResponse = await server.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: {
      username,
      password,
    },
  });

  const cookies = loginResponse.cookies;
  const sessionCookie = cookies.find((c: any) => c.name === 'session_id');

  if (!sessionCookie) {
    throw new Error('No session cookie found after login');
  }

  return {
    userId,
    sessionCookie: `${sessionCookie.name}=${sessionCookie.value}`,
  };
}
