import type { FastifyInstance } from 'fastify';
import { validateSchema, idParamSchema } from '@/utils/validation';
import { authenticateUser } from '@/modules/auth/auth.middleware';
import { directoriesService } from './directories.service';
import { watcherService } from './watcher.service';
import {
  createDirectorySchema,
  updateDirectorySchema,
} from './directories.types';

export async function directoriesRoutes(
  fastify: FastifyInstance
): Promise<void> {
  // All routes require authentication
  fastify.addHook('preHandler', authenticateUser);

  // Create directory
  fastify.post('/', async (request, reply) => {
    const input = validateSchema(createDirectorySchema, request.body);
    const directory = await directoriesService.create(input);

    // Trigger initial scan
    watcherService.scanDirectory(directory.id).catch((error) => {
      fastify.log.error(
        { error, directoryId: directory.id },
        'Failed to trigger initial directory scan'
      );
    });

    return reply.status(201).send({
      success: true,
      data: directory,
      message: 'Directory registered successfully. Scanning started.',
    });
  });

  // List all directories
  fastify.get('/', async (request, reply) => {
    const directories = await directoriesService.findAll();

    return reply.send({
      success: true,
      data: directories,
    });
  });

  // Get directory by ID
  fastify.get('/:id', async (request, reply) => {
    const { id } = validateSchema(idParamSchema, request.params);
    const directory = await directoriesService.findById(id);

    return reply.send({
      success: true,
      data: directory,
    });
  });

  // Update directory
  fastify.patch('/:id', async (request, reply) => {
    const { id } = validateSchema(idParamSchema, request.params);
    const input = validateSchema(updateDirectorySchema, request.body);
    const directory = await directoriesService.update(id, input);

    return reply.send({
      success: true,
      data: directory,
      message: 'Directory updated successfully',
    });
  });

  // Delete directory
  fastify.delete('/:id', async (request, reply) => {
    const { id } = validateSchema(idParamSchema, request.params);
    await directoriesService.delete(id);

    return reply.send({
      success: true,
      message: 'Directory removed successfully',
    });
  });

  // Trigger manual scan
  fastify.post('/:id/scan', async (request, reply) => {
    const { id } = validateSchema(idParamSchema, request.params);
    await directoriesService.findById(id); // Ensure exists

    // Trigger scan asynchronously
    watcherService.scanDirectory(id).catch((error) => {
      fastify.log.error({ error, directoryId: id }, 'Directory scan failed');
    });

    return reply.send({
      success: true,
      message: 'Directory scan started',
    });
  });

  // Get directory stats
  fastify.get('/:id/stats', async (request, reply) => {
    const { id } = validateSchema(idParamSchema, request.params);
    const stats = await directoriesService.getStats(id);

    return reply.send({
      success: true,
      data: stats,
    });
  });
}
