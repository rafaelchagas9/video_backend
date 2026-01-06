import type { FastifyInstance } from 'fastify';
import { validateSchema, idParamSchema } from '@/utils/validation';
import { authenticateUser } from '@/modules/auth/auth.middleware';
import { thumbnailsService } from './thumbnails.service';
import { generateThumbnailSchema } from './thumbnails.types';
import { readFileSync } from 'fs';

export async function thumbnailsRoutes(fastify: FastifyInstance): Promise<void> {
  // All routes require authentication
  fastify.addHook('preHandler', authenticateUser);

  // Generate thumbnail for video
  fastify.post('/videos/:id/thumbnails', async (request, reply) => {
    const { id } = validateSchema(idParamSchema, request.params);
    const input = validateSchema(generateThumbnailSchema, request.body);
    const thumbnail = await thumbnailsService.generate(id, input);

    return reply.status(201).send({
      success: true,
      data: thumbnail,
      message: 'Thumbnail generated successfully',
    });
  });

  // Get thumbnails for video
  fastify.get('/videos/:id/thumbnails', async (request, reply) => {
    const { id } = validateSchema(idParamSchema, request.params);
    const thumbnails = await thumbnailsService.getByVideoId(id);

    return reply.send({
      success: true,
      data: thumbnails,
    });
  });

  // Serve thumbnail image
  fastify.get('/thumbnails/:id/image', async (request, reply) => {
    const { id } = validateSchema(idParamSchema, request.params);
    const thumbnail = await thumbnailsService.findById(id);

    // Set correct content type (assuming jpg for now as per service)
    reply.header('Content-Type', 'image/jpeg');
    
    // Serve the file
    // Ideally use a stream or sendFile if fastify-static was used,
    // but here we can read it. For efficiency in production we'd use streams.
    // Given Bun, simple read works well for small images.
    const buffer = readFileSync(thumbnail.file_path);
    return reply.send(buffer);
  });

  // Delete thumbnail
  fastify.delete('/thumbnails/:id', async (request, reply) => {
    const { id } = validateSchema(idParamSchema, request.params);
    await thumbnailsService.delete(id);

    return reply.send({
      success: true,
      message: 'Thumbnail deleted successfully',
    });
  });
}
