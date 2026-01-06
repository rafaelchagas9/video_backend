import type { FastifyInstance } from 'fastify';
import { validateSchema, idParamSchema } from '@/utils/validation';
import { authenticateUser } from '@/modules/auth/auth.middleware';
import { creatorsService } from './creators.service';
import { createCreatorSchema, updateCreatorSchema } from './creators.types';

export async function creatorsRoutes(fastify: FastifyInstance): Promise<void> {
  // All routes require authentication
  fastify.addHook('preHandler', authenticateUser);

  // List all creators
  fastify.get('/', async (request, reply) => {
    const creators = await creatorsService.list();

    return reply.send({
      success: true,
      data: creators,
    });
  });

  // Get creator by ID
  fastify.get('/:id', async (request, reply) => {
    const { id } = validateSchema(idParamSchema, request.params);
    const creator = await creatorsService.findById(id);

    return reply.send({
      success: true,
      data: creator,
    });
  });

  // Create new creator
  fastify.post('/', async (request, reply) => {
    const input = validateSchema(createCreatorSchema, request.body);
    const creator = await creatorsService.create(input);

    return reply.status(201).send({
      success: true,
      data: creator,
      message: 'Creator created successfully',
    });
  });

  // Update creator
  fastify.patch('/:id', async (request, reply) => {
    const { id } = validateSchema(idParamSchema, request.params);
    const input = validateSchema(updateCreatorSchema, request.body);
    const creator = await creatorsService.update(id, input);

    return reply.send({
      success: true,
      data: creator,
      message: 'Creator updated successfully',
    });
  });

  // Delete creator
  fastify.delete('/:id', async (request, reply) => {
    const { id } = validateSchema(idParamSchema, request.params);
    await creatorsService.delete(id);

    return reply.send({
      success: true,
      message: 'Creator deleted successfully',
    });
  });

  // Get videos by creator
  fastify.get('/:id/videos', async (request, reply) => {
    const { id } = validateSchema(idParamSchema, request.params);
    const videos = await creatorsService.getVideos(id);

    return reply.send({
      success: true,
      data: videos,
    });
  });
}
