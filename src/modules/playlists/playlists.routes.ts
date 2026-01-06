import type { FastifyInstance } from 'fastify';
import { validateSchema, idParamSchema } from '@/utils/validation';
import { authenticateUser } from '@/modules/auth/auth.middleware';
import { playlistsService } from './playlists.service';
import { 
  createPlaylistSchema, 
  updatePlaylistSchema, 
  addVideoToPlaylistSchema,
  reorderPlaylistSchema 
} from './playlists.types';
import { z } from 'zod';

const videoIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
  video_id: z.coerce.number().int().positive(),
});

export async function playlistsRoutes(fastify: FastifyInstance): Promise<void> {
  // All routes require authentication
  fastify.addHook('preHandler', authenticateUser);

  // Create playlist
  fastify.post('/', async (request, reply) => {
    const input = validateSchema(createPlaylistSchema, request.body);
    const playlist = await playlistsService.create(request.user.id, input);

    return reply.status(201).send({
      success: true,
      data: playlist,
      message: 'Playlist created successfully',
    });
  });

  // List user's playlists
  fastify.get('/', async (request, reply) => {
    const playlists = await playlistsService.list(request.user.id);

    return reply.send({
      success: true,
      data: playlists,
    });
  });

  // Get playlist details
  fastify.get('/:id', async (request, reply) => {
    const { id } = validateSchema(idParamSchema, request.params);
    const playlist = await playlistsService.findById(id);

    return reply.send({
      success: true,
      data: playlist,
    });
  });

  // Update playlist
  fastify.patch('/:id', async (request, reply) => {
    const { id } = validateSchema(idParamSchema, request.params);
    const input = validateSchema(updatePlaylistSchema, request.body);
    const playlist = await playlistsService.update(id, request.user.id, input);

    return reply.send({
      success: true,
      data: playlist,
      message: 'Playlist updated successfully',
    });
  });

  // Delete playlist
  fastify.delete('/:id', async (request, reply) => {
    const { id } = validateSchema(idParamSchema, request.params);
    await playlistsService.delete(id, request.user.id);

    return reply.send({
      success: true,
      message: 'Playlist deleted successfully',
    });
  });

  // Get videos in playlist
  fastify.get('/:id/videos', async (request, reply) => {
    const { id } = validateSchema(idParamSchema, request.params);
    const videos = await playlistsService.getVideos(id, request.user.id);

    return reply.send({
      success: true,
      data: videos,
    });
  });

  // Add video to playlist
  fastify.post('/:id/videos', async (request, reply) => {
    const { id } = validateSchema(idParamSchema, request.params);
    const input = validateSchema(addVideoToPlaylistSchema, request.body);
    await playlistsService.addVideo(id, request.user.id, input.video_id, input.position);

    return reply.status(201).send({
      success: true,
      message: 'Video added to playlist',
    });
  });

  // Remove video from playlist
  fastify.delete('/:id/videos/:video_id', async (request, reply) => {
    const { id, video_id } = validateSchema(videoIdParamSchema, request.params);
    await playlistsService.removeVideo(id, request.user.id, video_id);

    return reply.send({
      success: true,
      message: 'Video removed from playlist',
    });
  });

  // Reorder videos in playlist
  fastify.patch('/:id/videos/reorder', async (request, reply) => {
    const { id } = validateSchema(idParamSchema, request.params);
    const input = validateSchema(reorderPlaylistSchema, request.body);
    await playlistsService.reorderVideos(id, request.user.id, input.videos);

    return reply.send({
      success: true,
      message: 'Playlist reordered successfully',
    });
  });
}
