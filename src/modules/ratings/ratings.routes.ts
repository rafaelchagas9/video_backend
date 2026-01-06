import type { FastifyInstance } from 'fastify';
import { validateSchema, idParamSchema } from '@/utils/validation';
import { authenticateUser } from '@/modules/auth/auth.middleware';
import { ratingsService } from './ratings.service';
import { updateRatingSchema } from './ratings.types';

export async function ratingsRoutes(fastify: FastifyInstance): Promise<void> {
  // All routes require authentication
  fastify.addHook('preHandler', authenticateUser);

  // Update rating
  fastify.patch('/:id', async (request, reply) => {
    const { id } = validateSchema(idParamSchema, request.params);
    const input = validateSchema(updateRatingSchema, request.body);
    const rating = await ratingsService.update(id, input);

    return reply.send({
      success: true,
      data: rating,
      message: 'Rating updated successfully',
    });
  });

  // Delete rating
  fastify.delete('/:id', async (request, reply) => {
    const { id } = validateSchema(idParamSchema, request.params);
    await ratingsService.delete(id);

    return reply.send({
      success: true,
      message: 'Rating deleted successfully',
    });
  });
}
