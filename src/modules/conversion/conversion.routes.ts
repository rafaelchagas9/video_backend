import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { conversionService } from './conversion.service';
import { authenticateUser } from '@/modules/auth/auth.middleware';
import { existsSync, createReadStream, statSync } from 'fs';
import { NotFoundError } from '@/utils/errors';
import {
  createConversionJobSchema,
  conversionJobResponseSchema,
  listConversionJobsResponseSchema,
  listPresetsResponseSchema,
  videoIdParamSchema,
  jobIdParamSchema,
} from './conversion.schemas';

export async function conversionRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // All routes require authentication
  app.addHook('preHandler', authenticateUser);

  /**
   * Create a conversion job for a video
   * POST /videos/:id/convert
   */
  app.post(
    '/videos/:id/convert',
    {
      schema: {
        tags: ['conversion'],
        summary: 'Start video conversion',
        description: 'Create a new conversion job for a video with the specified preset',
        params: videoIdParamSchema,
        body: createConversionJobSchema,
        response: {
          201: conversionJobResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: number };
      const { preset } = request.body as { preset: string };

      const job = await conversionService.createJob({
        video_id: id,
        preset,
      });

      return reply.status(201).send({ success: true, data: job });
    }
  );

  /**
   * List conversion jobs for a video
   * GET /videos/:id/conversions
   */
  app.get(
    '/videos/:id/conversions',
    {
      schema: {
        tags: ['conversion'],
        summary: 'List conversion jobs for video',
        description: 'Get all conversion jobs associated with a specific video',
        params: videoIdParamSchema,
        response: {
          200: listConversionJobsResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: number };
      const jobs = await conversionService.listByVideoId(id);
      return reply.send({ success: true, data: jobs });
    }
  );

  /**
   * Get conversion job by ID
   * GET /conversions/:id
   */
  app.get(
    '/conversions/:id',
    {
      schema: {
        tags: ['conversion'],
        summary: 'Get conversion job',
        description: 'Get details of a specific conversion job',
        params: jobIdParamSchema,
        response: {
          200: conversionJobResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: number };
      const job = await conversionService.findById(id);
      return reply.send({ success: true, data: job });
    }
  );

  /**
   * Cancel a pending conversion job
   * POST /conversions/:id/cancel
   */
  app.post(
    '/conversions/:id/cancel',
    {
      schema: {
        tags: ['conversion'],
        summary: 'Cancel conversion job',
        description: 'Cancel a pending conversion job',
        params: jobIdParamSchema,
        response: {
          200: conversionJobResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: number };
      const job = await conversionService.cancel(id);
      return reply.send({ success: true, data: job });
    }
  );

  /**
   * Delete a conversion job
   * DELETE /conversions/:id
   */
  app.delete(
    '/conversions/:id',
    {
      schema: {
        tags: ['conversion'],
        summary: 'Delete conversion job',
        description: 'Delete a completed/failed/cancelled conversion job and its output file',
        params: jobIdParamSchema,
        response: {
          200: z.object({
            success: z.literal(true),
            message: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: number };
      await conversionService.delete(id);
      return reply.send({ success: true, message: 'Job deleted' });
    }
  );

  /**
   * Download converted file
   * GET /conversions/:id/download
   */
  app.get(
    '/conversions/:id/download',
    {
      schema: {
        tags: ['conversion'],
        summary: 'Download converted file',
        description: 'Download the output file from a completed conversion job',
        params: jobIdParamSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: number };
      const job = await conversionService.findById(id);

      if (job.status !== 'completed' || !job.output_path) {
        throw new NotFoundError('Conversion not completed or output file not available');
      }

      if (!existsSync(job.output_path)) {
        throw new NotFoundError('Output file not found on disk');
      }

      const stats = statSync(job.output_path);
      const fileName = job.output_path.split('/').pop() || 'converted.mkv';

      return reply
        .header('Content-Type', 'video/x-matroska')
        .header('Content-Disposition', `attachment; filename="${fileName}"`)
        .header('Content-Length', stats.size)
        .send(createReadStream(job.output_path));
    }
  );

  /**
   * List available presets
   * GET /presets
   */
  app.get(
    '/presets',
    {
      schema: {
        tags: ['conversion'],
        summary: 'List available presets',
        description: 'Get all available conversion presets',
        response: {
          200: listPresetsResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      const presets = conversionService.getPresets();
      return reply.send({ success: true, data: presets });
    }
  );

  /**
   * Get queue status
   * GET /conversion/status
   */
  app.get(
    '/conversion/status',
    {
      schema: {
        tags: ['conversion'],
        summary: 'Get queue status',
        description: 'Get the current status of the conversion queue',
        response: {
          200: z.object({
            success: z.literal(true),
            data: z.object({
              queueLength: z.number(),
              activeJobs: z.number(),
              isProcessing: z.boolean(),
            }),
          }),
        },
      },
    },
    async (_request, reply) => {
      const status = await conversionService.getQueueStatus();
      return reply.send({ success: true, data: status });
    }
  );
}
