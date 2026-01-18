import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { authenticateUser } from '@/modules/auth/auth.middleware';
import { getFaceRecognitionService } from './face-recognition.service';
import { getFaceRecognitionClient } from './face-recognition.client';
import {
  searchByFaceSchema,
  getVideosByFaceSchema,
} from './face-recognition.schemas';

export async function faceRecognitionRoutes(server: FastifyInstance) {
  const app = server.withTypeProvider<ZodTypeProvider>();
  const faceService = getFaceRecognitionService();
  const faceClient = getFaceRecognitionClient();

  /**
   * Health check - Face service status
   */
  app.get(
    '/faces/health',
    {
      preHandler: authenticateUser,
      schema: {
        tags: ['face-recognition'],
        summary: 'Health check for face recognition service',
        response: {
          200: z.object({
            success: z.boolean(),
            data: z.object({
              status: z.string(),
              version: z.string(),
            }).catchall(z.any()),
          }),
        },
      },
    },
    async (request, reply) => {
      const health = await faceClient.healthCheck();
      return reply.send({
        success: true,
        data: health,
      });
    },
  );

  /**
   * Upload reference face for creator (file upload)
   */
  app.post(
    '/creators/:id/face-embeddings',
    {
      preHandler: authenticateUser,
      schema: {
        tags: ['face-recognition'],
        summary: 'Upload reference face for creator (file upload)',
        params: z.object({
          id: z.coerce.number().int(),
        }),
        response: {
          200: z.object({
            success: z.boolean(),
            data: z.any(),
          }),
        },
      },
    },
    async (request, reply) => {
      const creatorId = request.params.id;

      // Handle file upload (multipart/form-data)
      const data = await request.file();

      if (!data) {
        return reply.code(400).send({
          success: false,
          error: { message: 'No file uploaded', statusCode: 400 },
        } as any);
      }

      // Save uploaded file temporarily
      const tmpPath = `/tmp/face_upload_${Date.now()}_${data.filename}`;
      const buffer = await data.toBuffer();
      await Bun.write(tmpPath, buffer);

      try {
        const embedding = await faceService.addCreatorEmbedding({
          creatorId,
          imagePath: tmpPath,
          sourceType: 'manual_upload',
        });

        // Clean up temp file
        await Bun.file(tmpPath).delete();

        return reply.send({
          success: true,
          data: embedding,
        });
      } catch (error) {
        // Clean up temp file on error
        try {
          await Bun.file(tmpPath).delete();
        } catch {}
        throw error;
      }
    },
  );

  /**
   * Upload reference face for creator (base64)
   */
  app.post(
    '/creators/:id/face-embeddings/base64',
    {
      preHandler: authenticateUser,
      schema: {
        tags: ['face-recognition'],
        summary: 'Upload reference face for creator (base64)',
        params: z.object({
          id: z.coerce.number().int(),
        }),
        body: z.object({
          image_base64: z.string(),
          is_primary: z.boolean().optional(),
        }),
        response: {
          200: z.object({
            success: z.boolean(),
            data: z.any(),
          }),
        },
      },
    },
    async (request, reply) => {
      const creatorId = request.params.id;
      const { image_base64, is_primary } = request.body;

      // Decode base64 and save temporarily
      const buffer = Buffer.from(image_base64, 'base64');
      const tmpPath = `/tmp/face_upload_${Date.now()}.jpg`;
      await Bun.write(tmpPath, buffer);

      try {
        const embedding = await faceService.addCreatorEmbedding({
          creatorId,
          imagePath: tmpPath,
          sourceType: 'manual_upload',
          isPrimary: is_primary,
        });

        // Clean up temp file
        await Bun.file(tmpPath).delete();

        return reply.send({
          success: true,
          data: embedding,
        });
      } catch (error) {
        // Clean up temp file on error
        try {
          await Bun.file(tmpPath).delete();
        } catch {}
        throw error;
      }
    },
  );

  /**
   * Get reference faces for creator
   */
  app.get(
    '/creators/:id/face-embeddings',
    {
      preHandler: authenticateUser,
      schema: {
        tags: ['face-recognition'],
        summary: 'Get reference faces for creator',
        params: z.object({
          id: z.coerce.number().int(),
        }),
        response: {
          200: z.object({
            success: z.boolean(),
            data: z.array(z.any()),
          }),
        },
      },
    },
    async (request, reply) => {
      const creatorId = request.params.id;
      const embeddings = await faceService.getCreatorEmbeddings(creatorId);

      return reply.send({
        success: true,
        data: embeddings,
      });
    },
  );

  /**
   * Set primary reference face for creator
   */
  app.put(
    '/creators/:id/face-embeddings/:eid/primary',
    {
      preHandler: authenticateUser,
      schema: {
        tags: ['face-recognition'],
        summary: 'Set primary reference face for creator',
        params: z.object({
          id: z.coerce.number().int(),
          eid: z.coerce.number().int(),
        }),

        response: {
          200: z.object({
            success: z.boolean(),
            data: z.object({ message: z.string() }),
          }),
        },
      },
    },
    async (request, reply) => {
      const creatorId = request.params.id;
      const embeddingId = request.params.eid;

      await faceService.setPrimaryEmbedding(creatorId, embeddingId);

      return reply.send({
        success: true,
        data: { message: 'Primary embedding updated' },
      });
    },
  );

  /**
   * Delete reference face
   */
  app.delete(
    '/creators/:id/face-embeddings/:eid',
    {
      preHandler: authenticateUser,
      schema: {
        tags: ['face-recognition'],
        summary: 'Delete reference face',
        params: z.object({
          id: z.coerce.number().int(),
          eid: z.coerce.number().int(),
        }),
        response: {
          200: z.object({
            success: z.boolean(),
            data: z.object({ message: z.string() }),
          }),
        },
      },
    },
    async (request, reply) => {
      const embeddingId = request.params.eid;

      await faceService.deleteCreatorEmbedding(embeddingId);

      return reply.send({
        success: true,
        data: { message: 'Face embedding deleted' },
      });
    },
  );

  /**
   * Get detected faces in video
   */
  app.get(
    '/videos/:id/faces',
    {
      preHandler: authenticateUser,
      schema: {
        tags: ['face-recognition'],
        summary: 'Get detected faces in video',
        params: z.object({
          id: z.coerce.number().int(),
        }),
        response: {
          200: z.object({
            success: z.boolean(),
            data: z.array(z.any()),
          }),
        },
      },
    },
    async (request, reply) => {
      const videoId = request.params.id;
      const detections = await faceService.getVideoFaceDetections(videoId);

      return reply.send({
        success: true,
        data: detections,
      });
    },
  );

  /**
   * Trigger face extraction for video
   */
  app.post(
    '/videos/:id/faces/extract',
    {
      preHandler: authenticateUser,
      schema: {
        tags: ['face-recognition'],
        summary: 'Trigger face extraction for video',
        params: z.object({
          id: z.coerce.number().int(),
        }),

        response: {
          200: z.object({
            success: z.boolean(),
            data: z.object({ message: z.string() }),
          }),
        },
      },
    },
    async (request, reply) => {
      const videoId = request.params.id;

      // Get video details
      const { videosService } = await import('@/modules/videos/videos.service');
      const video = await videosService.findById(videoId);

      if (!video.duration_seconds) {
        return reply.code(400).send({
          success: false,
          error: {
            message: 'Video duration not available for face extraction',
            statusCode: 400,
          },
        } as any);
      }

      // Trigger face recognition workflow
      await faceService.processVideo(
        videoId,
        video.file_path,
        video.duration_seconds,
      );

      return reply.send({
        success: true,
        data: { message: 'Face extraction started' },
      });
    },
  );

  /**
   * Confirm face match
   */
  app.put(
    '/videos/:id/faces/:did/confirm',
    {
      preHandler: authenticateUser,
      schema: {
        tags: ['face-recognition'],
        summary: 'Confirm face match',
        params: z.object({
          id: z.coerce.number().int(),
          did: z.coerce.number().int(),
        }),
        body: z.object({
          creator_id: z.number().int(),
        }),
        response: {
          200: z.object({
            success: z.boolean(),
            data: z.object({ message: z.string() }),
          }),
        },
      },
    },
    async (request, reply) => {
      const detectionId = request.params.did;
      const { creator_id } = request.body;

      await faceService.confirmFaceMatch(detectionId, creator_id);

      return reply.send({
        success: true,
        data: { message: 'Face match confirmed' },
      });
    },
  );

  /**
   * Reject face match
   */
  app.put(
    '/videos/:id/faces/:did/reject',
    {
      preHandler: authenticateUser,
      schema: {
        tags: ['face-recognition'],
        summary: 'Reject face match',
        params: z.object({
          id: z.coerce.number().int(),
          did: z.coerce.number().int(),
        }),

        response: {
          200: z.object({
            success: z.boolean(),
            data: z.object({ message: z.string() }),
          }),
        },
      },
    },
    async (request, reply) => {
      const detectionId = request.params.did;

      await faceService.rejectFaceMatch(detectionId);

      return reply.send({
        success: true,
        data: { message: 'Face match rejected' },
      });
    },
  );

  /**
   * Get videos containing creator (by face)
   */
  app.get(
    '/creators/:id/videos-by-face',
    {
      preHandler: authenticateUser,
      schema: {
        tags: ['face-recognition'],
        summary: 'Get videos containing creator (by face)',
        params: z.object({
          id: z.coerce.number().int(),
        }),
        querystring: getVideosByFaceSchema,
        response: {
          200: z.object({
            success: z.boolean(),
            data: z.array(z.any()),
          }),
        },
      },
    },
    async (request, reply) => {
      const creatorId = request.params.id;
      const minConfidence = request.query.min_confidence ?? 0.65;

      const videos = await faceService.findVideosWithCreator(
        creatorId,
        minConfidence,
      );

      return reply.send({
        success: true,
        data: videos,
      });
    },
  );

  /**
   * Search creators by uploaded face image
   */
  app.post(
    '/faces/search',
    {
      preHandler: authenticateUser,
      schema: {
        tags: ['face-recognition'],
        summary: 'Search creators by uploaded face image',
        querystring: searchByFaceSchema,
        response: {
          200: z.object({
            success: z.boolean(),
            data: z.array(z.any()),
          }),
        },
      },
    },
    async (request, reply) => {
      const limit = request.query.limit ?? 10;
      const threshold = request.query.threshold ?? 0.65;

      // Handle file upload
      const data = await request.file();

      if (!data) {
        return reply.code(400).send({
          success: false,
          error: { message: 'No file uploaded', statusCode: 400 },
        } as any);
      }

      // Save uploaded file temporarily
      const tmpPath = `/tmp/face_search_${Date.now()}_${data.filename}`;
      const buffer = await data.toBuffer();
      await Bun.write(tmpPath, buffer);

      try {
        // Detect face in uploaded image
        const result = await faceClient.detectFacesFromFile(tmpPath);

        if (result.faces.length === 0) {
          await Bun.file(tmpPath).delete();
          return reply.code(400).send({
            success: false,
            error: { message: 'No face detected in image', statusCode: 400 },
          } as any);
        }

        // Use first detected face
        const face = result.faces[0];

        // Search for similar creators
        const matches = await faceService.findSimilarCreators(
          face.embedding,
          limit,
          threshold,
        );

        // Clean up temp file
        await Bun.file(tmpPath).delete();

        return reply.send({
          success: true,
          data: matches,
        });
      } catch (error) {
        // Clean up temp file on error
        try {
          await Bun.file(tmpPath).delete();
        } catch {}
        throw error;
      }
    },
  );

  /**
   * Get face extraction job status for video
   */
  app.get(
    '/videos/:id/faces/status',
    {
      preHandler: authenticateUser,
      schema: {
        tags: ['face-recognition'],
        summary: 'Get face extraction job status for video',
        params: z.object({
          id: z.coerce.number().int(),
        }),
        response: {
          200: z.object({
            success: z.boolean(),
            data: z.any(),
          }),
        },
      },
    },
    async (request, reply) => {
      const videoId = request.params.id;

      try {
        const job = await faceService.getFaceExtractionJob(videoId);
        return reply.send({
          success: true,
          data: job,
        });
      } catch (error) {
        return reply.code(404).send({
          success: false,
          error: {
            message: 'Face extraction job not found',
            statusCode: 404,
          },
        } as any);
      }
    },
  );

  /**
   * Clear face extraction queue
   */
  app.delete(
    '/faces/queue',
    {
      preHandler: authenticateUser,
      schema: {
        tags: ['face-recognition'],
        summary: 'Clear face extraction queue',
        description: 'Removes all pending jobs from the queue and marks them as skipped.',
        response: {
          200: z.object({
            success: z.boolean(),
            data: z.object({ message: z.string() }),
          }),
        },
      },
    },
    async (request, reply) => {
      await faceService.clearQueue();

      return reply.send({
        success: true,
        data: { message: 'Face extraction queue cleared' },
      });
    },
  );
}
