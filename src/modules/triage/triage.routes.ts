import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { authenticateUser } from '@/modules/auth/auth.middleware';
import { triageService } from './triage.service';
import {
  saveTriageProgressSchema,
  getTriageProgressQuerySchema,
  triageProgressResponseSchema,
  saveTriageProgressResponseSchema,
  errorResponseSchema,
} from './triage.schemas';

export async function triageRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.addHook('preHandler', authenticateUser);

  // Save triage progress
  app.post(
    '/triage-progress',
    {
      schema: {
        tags: ['users', 'triage'],
        summary: 'Save triage progress',
        description: 'Persist triage session progress for resuming later. Uses upsert logic to update existing progress.',
        body: saveTriageProgressSchema,
        response: {
          200: saveTriageProgressResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      await triageService.saveProgress(request.user!.id, request.body);

      return reply.send({
        success: true,
        message: 'Progress saved',
      });
    },
  );

  // Get triage progress
  app.get(
    '/triage-progress',
    {
      schema: {
        tags: ['users', 'triage'],
        summary: 'Get triage progress',
        description: 'Retrieve saved triage progress for a specific filter key. Returns null if no progress exists.',
        querystring: getTriageProgressQuerySchema,
        response: {
          200: triageProgressResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const progress = await triageService.getProgress(
        request.user!.id,
        request.query
      );

      return reply.send({
        success: true,
        data: progress ? {
          filter_key: progress.filter_key,
          last_video_id: progress.last_video_id,
          processed_count: progress.processed_count,
          total_count: progress.total_count,
          updated_at: progress.updated_at,
        } : null,
      });
    },
  );
}
