import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { validateSchema, idParamSchema } from '@/utils/validation';
import { authenticateUser } from '@/modules/auth/auth.middleware';
import { tagsService } from './tags.service';
import { createTagSchema, updateTagSchema } from './tags.types';

const treeQuerySchema = z.object({
  tree: z.enum(['true', 'false']).optional().default('false'),
});

export async function tagsRoutes(fastify: FastifyInstance): Promise<void> {
  // All routes require authentication
  fastify.addHook('preHandler', authenticateUser);

  // List all tags (optionally as tree)
  fastify.get('/', async (request, reply) => {
    const { tree } = validateSchema(treeQuerySchema, request.query);

    if (tree === 'true') {
      const tagTree = await tagsService.getTree();
      return reply.send({
        success: true,
        data: tagTree,
      });
    }

    const tags = await tagsService.list();
    return reply.send({
      success: true,
      data: tags,
    });
  });

  // Get tag by ID (with path)
  fastify.get('/:id', async (request, reply) => {
    const { id } = validateSchema(idParamSchema, request.params);
    const tag = await tagsService.findByIdWithPath(id);

    return reply.send({
      success: true,
      data: tag,
    });
  });

  // Create new tag
  fastify.post('/', async (request, reply) => {
    const input = validateSchema(createTagSchema, request.body);
    const tag = await tagsService.create(input);

    return reply.status(201).send({
      success: true,
      data: tag,
      message: 'Tag created successfully',
    });
  });

  // Update tag
  fastify.patch('/:id', async (request, reply) => {
    const { id } = validateSchema(idParamSchema, request.params);
    const input = validateSchema(updateTagSchema, request.body);
    const tag = await tagsService.update(id, input);

    return reply.send({
      success: true,
      data: tag,
      message: 'Tag updated successfully',
    });
  });

  // Delete tag (cascades to children)
  fastify.delete('/:id', async (request, reply) => {
    const { id } = validateSchema(idParamSchema, request.params);
    await tagsService.delete(id);

    return reply.send({
      success: true,
      message: 'Tag deleted successfully',
    });
  });

  // Get child tags
  fastify.get('/:id/children', async (request, reply) => {
    const { id } = validateSchema(idParamSchema, request.params);
    const children = await tagsService.getChildren(id);

    return reply.send({
      success: true,
      data: children,
    });
  });

  // Get videos with tag
  fastify.get('/:id/videos', async (request, reply) => {
    const { id } = validateSchema(idParamSchema, request.params);
    const videos = await tagsService.getVideos(id);

    return reply.send({
      success: true,
      data: videos,
    });
  });
}
