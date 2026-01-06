import type { FastifyInstance } from 'fastify';
import { validateSchema } from '@/utils/validation';
import { authenticateUser } from '@/modules/auth/auth.middleware';
import { favoritesService } from './favorites.service';
import { addFavoriteSchema } from './favorites.types';
import { z } from 'zod';

const videoIdParamSchema = z.object({
  video_id: z.coerce.number().int().positive(),
});

export async function favoritesRoutes(fastify: FastifyInstance): Promise<void> {
  // All routes require authentication
  fastify.addHook('preHandler', authenticateUser);

  // List all favorites
  fastify.get('/', async (request, reply) => {
    const favorites = await favoritesService.list(request.user.id);

    return reply.send({
      success: true,
      data: favorites,
    });
  });

  // Add video to favorites
  fastify.post('/', async (request, reply) => {
    const input = validateSchema(addFavoriteSchema, request.body);
    await favoritesService.add(request.user.id, input.video_id);

    return reply.status(201).send({
      success: true,
      message: 'Video added to favorites',
    });
  });

  // Remove video from favorites
  fastify.delete('/:video_id', async (request, reply) => {
    const { video_id } = validateSchema(videoIdParamSchema, request.params);
    await favoritesService.remove(request.user.id, video_id);

    return reply.send({
      success: true,
      message: 'Video removed from favorites',
    });
  });

  // Check if video is favorited
  fastify.get('/:video_id/check', async (request, reply) => {
    const { video_id } = validateSchema(videoIdParamSchema, request.params);
    const isFavorite = await favoritesService.isFavorite(request.user.id, video_id);

    return reply.send({
      success: true,
      data: { is_favorite: isFavorite },
    });
  });
}
