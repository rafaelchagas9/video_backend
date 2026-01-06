import type { FastifyInstance } from 'fastify';
import { validateSchema, idParamSchema } from '@/utils/validation';
import { authenticateUser } from '@/modules/auth/auth.middleware';
import { bookmarksService } from './bookmarks.service';
import { updateBookmarkSchema } from './bookmarks.types';

export async function bookmarksRoutes(fastify: FastifyInstance): Promise<void> {
  // All routes require authentication
  fastify.addHook('preHandler', authenticateUser);

  // Update bookmark
  fastify.patch('/:id', async (request, reply) => {
    const { id } = validateSchema(idParamSchema, request.params);
    const input = validateSchema(updateBookmarkSchema, request.body);
    const bookmark = await bookmarksService.update(id, request.user.id, input);

    return reply.send({
      success: true,
      data: bookmark,
      message: 'Bookmark updated successfully',
    });
  });

  // Delete bookmark
  fastify.delete('/:id', async (request, reply) => {
    const { id } = validateSchema(idParamSchema, request.params);
    await bookmarksService.delete(id, request.user.id);

    return reply.send({
      success: true,
      message: 'Bookmark deleted successfully',
    });
  });
}
