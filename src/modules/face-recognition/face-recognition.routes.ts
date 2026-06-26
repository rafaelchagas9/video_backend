import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { readFileSync, existsSync } from "fs";
import { logger } from "@/utils/logger";
import { authenticateUser } from "@/modules/auth/auth.middleware";
import { getFaceRecognitionService } from "./face-recognition.service";
import { getFaceRecognitionClient } from "./face-recognition.client";
import { getFaceImagesService } from "./face-images.service";
import {
  searchByFaceSchema,
  getVideosByFaceSchema,
  videoFacesResponseSchema,
} from "./face-recognition.schemas";
import { and, eq } from "drizzle-orm";
import { creatorFaceEmbeddingsTable } from "@/database/schema";
import { db } from "@/config/drizzle";

export async function faceRecognitionRoutes(server: FastifyInstance) {
  const app = server.withTypeProvider<ZodTypeProvider>();
  const faceService = getFaceRecognitionService();
  const faceClient = getFaceRecognitionClient();
  const faceImagesService = getFaceImagesService();

  /**
   * Health check - Face service status
   */
  app.get(
    "/faces/health",
    {
      preHandler: authenticateUser,
      schema: {
        tags: ["face-recognition"],
        summary: "Health check for face recognition service",
        response: {
          200: z.object({
            success: z.boolean(),
            data: z
              .object({
                status: z.string(),
                version: z.string().optional(),
              })
              .catchall(z.any()),
          }),
        },
      },
    },
    async (_request, reply) => {
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
    "/creators/:id/face-embeddings",
    {
      preHandler: authenticateUser,
      schema: {
        tags: ["face-recognition"],
        summary: "Upload reference face for creator (file upload)",
        params: z.object({
          id: z.coerce.number().int(),
        }),
        response: {
          200: z.object({
            success: z.boolean(),
            data: z.any(),
          }),
          400: z.object({
            success: z.boolean(),
            error: z.object({
              message: z.string(),
              statusCode: z.number(),
            }),
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
          error: { message: "No file uploaded", statusCode: 400 },
        });
      }

      // Save uploaded file temporarily
      const tmpPath = `/tmp/face_upload_${Date.now()}_${data.filename}`;
      const buffer = await data.toBuffer();
      await Bun.write(tmpPath, buffer);

      try {
        const embedding = await faceService.addCreatorEmbedding({
          creatorId,
          imagePath: tmpPath,
          sourceType: "manual_upload",
        });

        // Clean up temp file
        await Bun.file(tmpPath).delete();

        // Exclude internal fields: thumbnailPath (security) and embedding (not needed by frontend)
        const {
          thumbnailPath,
          embedding: _embedding,
          ...enrichedEmbedding
        } = embedding;

        const response = {
          ...enrichedEmbedding,
          image_url: thumbnailPath
            ? `/api/creators/${creatorId}/face-embeddings/${embedding.id}/thumbnail`
            : null,
        };

        return reply.send({
          success: true,
          data: response,
        });
      } catch (error) {
        // Clean up temp file on error
        try {
          await Bun.file(tmpPath).delete();
        } catch {
          // Ignore cleanup errors
        }
        throw error;
      }
    },
  );

  /**
   * Upload reference face for creator (base64)
   */
  app.post(
    "/creators/:id/face-embeddings/base64",
    {
      preHandler: authenticateUser,
      schema: {
        tags: ["face-recognition"],
        summary: "Upload reference face for creator (base64)",
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
      const buffer = Buffer.from(image_base64, "base64");
      const tmpPath = `/tmp/face_upload_${Date.now()}.jpg`;
      await Bun.write(tmpPath, buffer);

      try {
        const embedding = await faceService.addCreatorEmbedding({
          creatorId,
          imagePath: tmpPath,
          sourceType: "manual_upload",
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
        } catch {
          // Ignore cleanup errors
        }
        throw error;
      }
    },
  );

  /**
   * Extract reference face from an existing gallery image
   *
   * Reuses the gallery image already stored on disk (no re-upload) and runs
   * the same embedding pipeline used for manual uploads / profile pictures.
   */
  app.post(
    "/creators/:id/face-embeddings/from-gallery/:mediaId",
    {
      preHandler: authenticateUser,
      schema: {
        tags: ["face-recognition"],
        summary: "Extract reference face from an existing gallery image",
        params: z.object({
          id: z.coerce.number().int(),
          mediaId: z.coerce.number().int(),
        }),
        response: {
          200: z.object({
            success: z.boolean(),
            data: z.any(),
          }),
          400: z.object({
            success: z.boolean(),
            error: z.object({
              message: z.string(),
              statusCode: z.number(),
            }),
          }),
        },
      },
    },
    async (request, reply) => {
      const creatorId = request.params.id;
      const mediaId = request.params.mediaId;

      // Resolve the stored gallery file (scoped to the creator).
      const { creatorsSocialService } =
        await import("@/modules/creators/creators.social.service");
      const media = await creatorsSocialService.getGalleryMediaById(
        creatorId,
        mediaId,
      );

      if (!media.file_path || !existsSync(media.file_path)) {
        return reply.code(400).send({
          success: false,
          error: {
            message: "Gallery image file not found on disk",
            statusCode: 400,
          },
        });
      }

      let embedding;
      try {
        embedding = await faceService.addCreatorEmbedding({
          creatorId,
          imagePath: media.file_path,
          sourceType: "gallery_media",
        });
      } catch (error) {
        if (error instanceof Error && /no face detected/i.test(error.message)) {
          return reply.code(400).send({
            success: false,
            error: {
              message: "No face detected in this image",
              statusCode: 400,
            },
          });
        }
        throw error;
      }

      // Exclude internal fields: thumbnailPath (security) and embedding (not needed by frontend)
      const {
        thumbnailPath,
        embedding: _embedding,
        ...enrichedEmbedding
      } = embedding;

      return reply.send({
        success: true,
        data: {
          ...enrichedEmbedding,
          image_url: thumbnailPath
            ? `/api/creators/${creatorId}/face-embeddings/${embedding.id}/thumbnail`
            : null,
        },
      });
    },
  );

  /**
   * Get reference faces for creator
   */
  app.get(
    "/creators/:id/face-embeddings",
    {
      preHandler: authenticateUser,
      schema: {
        tags: ["face-recognition"],
        summary: "Get reference faces for creator",
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

      const enriched = embeddings.map((embedding) => {
        // Exclude internal fields: thumbnailPath (security) and embedding (not needed by frontend)
        const {
          thumbnailPath,
          embedding: _embedding,
          ...enrichedEmbedding
        } = embedding;

        return {
          ...enrichedEmbedding,
          image_url: thumbnailPath
            ? `/api/creators/${creatorId}/face-embeddings/${embedding.id}/thumbnail`
            : null,
        };
      });

      return reply.send({
        success: true,
        data: enriched,
      });
    },
  );

  /**
   * Set primary reference face for creator
   */
  app.put(
    "/creators/:id/face-embeddings/:eid/primary",
    {
      preHandler: authenticateUser,
      schema: {
        tags: ["face-recognition"],
        summary: "Set primary reference face for creator",
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
        data: { message: "Primary embedding updated" },
      });
    },
  );

  /**
   * Delete reference face
   */
  app.delete(
    "/creators/:id/face-embeddings/:eid",
    {
      preHandler: authenticateUser,
      schema: {
        tags: ["face-recognition"],
        summary: "Delete reference face",
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
        data: { message: "Face embedding deleted" },
      });
    },
  );

  /**
   * Serve creator face embedding thumbnail
   */
  server.get(
    "/creators/:id/face-embeddings/:eid/thumbnail",
    {
      schema: {
        tags: ["face-recognition"],
        summary: "Get creator face embedding thumbnail",
        description:
          "Serves the compressed thumbnail image for a creator face embedding",
        params: z.object({
          id: z.coerce.number().int().describe("Creator ID"),
          eid: z.coerce.number().int().describe("Embedding ID"),
        }),
        response: {
          404: z.object({
            success: z.boolean(),
            error: z.object({
              message: z.string(),
              statusCode: z.number(),
            }),
          }),
        },
      },
    },
    async (request, reply) => {
      const { id: creatorId, eid: embeddingId } = request.params as {
        id: string;
        eid: string;
      };

      // Get embedding from database
      const embedding = await db
        .select({ thumbnailPath: creatorFaceEmbeddingsTable.thumbnailPath })
        .from(creatorFaceEmbeddingsTable)
        .where(
          and(
            eq(creatorFaceEmbeddingsTable.id, Number(embeddingId)),
            eq(creatorFaceEmbeddingsTable.creatorId, Number(creatorId)),
          ),
        )
        .limit(1)
        .then((rows) => rows[0]);

      if (!embedding || !embedding.thumbnailPath) {
        return reply.code(404).send({
          success: false,
          error: { message: "Thumbnail not found", statusCode: 404 },
        });
      }

      if (!existsSync(embedding.thumbnailPath)) {
        return reply.code(404).send({
          success: false,
          error: { message: "Thumbnail file not found", statusCode: 404 },
        });
      }

      reply.header("Content-Type", "image/webp");
      const buffer = readFileSync(embedding.thumbnailPath);
      return reply.send(buffer);
    },
  );

  /**
   * Get detected faces in video (enhanced, frontend-friendly)
   */
  app.get(
    "/videos/:id/faces",
    {
      preHandler: authenticateUser,
      schema: {
        tags: ["face-recognition"],
        summary: "Get detected faces in video",
        description:
          "Returns face detections with creator info and face image URLs. Excludes internal fields (embeddings, bbox coordinates).",
        params: z.object({
          id: z.coerce.number().int(),
        }),
        response: {
          200: videoFacesResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const videoId = request.params.id;
      const detections = await faceService.getVideoFaceDetections(videoId);

      // Import creators service for enrichment
      const { creatorsService } =
        await import("@/modules/creators/creators.service");

      // Enrich with creator data and face image URLs
      const enriched = await Promise.all(
        detections.map(async (detection) => {
          // Face image URL uses detection ID (lazy generation on access)
          const faceImageUrl = `/api/faces/${detection.id}/image`;

          // Get creator data if matched
          let matchedCreator = undefined;
          if (detection.matchedCreatorId) {
            try {
              const creator = await creatorsService.findById(
                detection.matchedCreatorId,
              );
              matchedCreator = {
                id: creator.id,
                name: creator.name,
                profilePictureUrl: creator.profile_picture_url || null,
              };
            } catch {
              // Creator might have been deleted
            }
          }

          return {
            id: detection.id,
            videoId: detection.videoId,
            timestampSeconds: detection.timestampSeconds,
            frameIndex: detection.frameIndex,
            detectionConfidence: detection.detScore,
            matchedCreator,
            matchConfidence: detection.matchConfidence || null,
            matchStatus: detection.matchStatus as
              | "pending"
              | "confirmed"
              | "rejected"
              | "no_match",
            estimatedAge: detection.estimatedAge || null,
            estimatedGender:
              (detection.estimatedGender as "M" | "F" | null) || null,
            faceImageUrl,
            createdAt: detection.createdAt.toISOString(),
            updatedAt: detection.updatedAt.toISOString(),
          };
        }),
      );

      return reply.send({
        success: true,
        data: enriched,
      });
    },
  );

  /**
   * Serve face image
   */
  server.get(
    "/faces/:id/image",
    {
      schema: {
        tags: ["face-recognition"],
        summary: "Get face image",
        description:
          "Serves the cropped face thumbnail image file. Generates on first access if not yet cached.",
        params: z.object({
          id: z.coerce.number().int().describe("Detection ID"),
        }),
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const detectionId = Number(id);

      // Lazy generation: get existing or generate new
      const faceImage =
        await faceImagesService.getOrGenerateByDetectionId(detectionId);

      // Determine MIME type from file extension
      const ext = faceImage.filePath.split(".").pop()?.toLowerCase();
      const mimeType = ext === "webp" ? "image/webp" : "image/jpeg";

      reply.header("Content-Type", mimeType);
      const buffer = readFileSync(faceImage.filePath);
      return reply.send(buffer);
    },
  );

  /**
   * Trigger face extraction for video
   */
  app.post(
    "/videos/:id/faces/extract",
    {
      preHandler: authenticateUser,
      schema: {
        tags: ["face-recognition"],
        summary: "Trigger face extraction for video",
        params: z.object({
          id: z.coerce.number().int(),
        }),

        response: {
          200: z.object({
            success: z.boolean(),
            data: z.object({ message: z.string() }),
          }),
          202: z.object({
            success: z.boolean(),
            data: z.object({ message: z.string() }),
          }),
          400: z.object({
            success: z.boolean(),
            error: z.object({
              message: z.string(),
              statusCode: z.number(),
            }),
          }),
        },
      },
    },
    async (request, reply) => {
      const videoId = request.params.id;

      // Get video details
      const { videosService } = await import("@/modules/videos/videos.service");
      const video = await videosService.findById(videoId);

      if (!video.duration_seconds) {
        return reply.code(400).send({
          success: false,
          error: {
            message: "Video duration not available for face extraction",
            statusCode: 400,
          },
        });
      }

      // Trigger face-only workflow (fire-and-forget)
      faceService
        .processFacesOnly(videoId, video.file_path, video.duration_seconds)
        .catch((error) => {
          logger.error(
            { videoId, error },
            "Face extraction failed in background",
          );
        });

      return reply.code(202).send({
        success: true,
        data: { message: "Face extraction started" },
      });
    },
  );

  /**
   * Confirm face match
   */
  app.put(
    "/videos/:id/faces/:did/confirm",
    {
      preHandler: authenticateUser,
      schema: {
        tags: ["face-recognition"],
        summary: "Confirm face match",
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
        data: { message: "Face match confirmed" },
      });
    },
  );

  /**
   * Reject face match
   */
  app.put(
    "/videos/:id/faces/:did/reject",
    {
      preHandler: authenticateUser,
      schema: {
        tags: ["face-recognition"],
        summary: "Reject face match",
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
        data: { message: "Face match rejected" },
      });
    },
  );

  /**
   * Get videos containing creator (by face)
   */
  app.get(
    "/creators/:id/videos-by-face",
    {
      preHandler: authenticateUser,
      schema: {
        tags: ["face-recognition"],
        summary: "Get videos containing creator (by face)",
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
    "/faces/search",
    {
      preHandler: authenticateUser,
      schema: {
        tags: ["face-recognition"],
        summary: "Search creators by uploaded face image",
        querystring: searchByFaceSchema,
        response: {
          200: z.object({
            success: z.boolean(),
            data: z.array(z.any()),
          }),
          400: z.object({
            success: z.boolean(),
            error: z.object({
              message: z.string(),
              statusCode: z.number(),
            }),
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
          error: { message: "No file uploaded", statusCode: 400 },
        });
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
            error: { message: "No face detected in image", statusCode: 400 },
          });
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
        } catch {
          // Ignore cleanup errors
        }
        throw error;
      }
    },
  );

  /**
   * Get face extraction job status for video
   */
  app.get(
    "/videos/:id/faces/status",
    {
      preHandler: authenticateUser,
      schema: {
        tags: ["face-recognition"],
        summary: "Get face extraction job status for video",
        params: z.object({
          id: z.coerce.number().int(),
        }),
        response: {
          200: z.object({
            success: z.boolean(),
            data: z.any(),
          }),
          404: z.object({
            success: z.boolean(),
            error: z.object({
              message: z.string(),
              statusCode: z.number(),
            }),
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
      } catch {
        return reply.code(404).send({
          success: false,
          error: {
            message: "Face extraction job not found",
            statusCode: 404,
          },
        });
      }
    },
  );

  /**
   * Clear face extraction queue
   */
  app.delete(
    "/faces/queue",
    {
      preHandler: authenticateUser,
      schema: {
        tags: ["face-recognition"],
        summary: "Clear face extraction queue",
        description:
          "Removes all pending jobs from the queue and marks them as skipped.",
        response: {
          200: z.object({
            success: z.boolean(),
            data: z.object({ message: z.string() }),
          }),
        },
      },
    },
    async (_request, reply) => {
      await faceService.clearQueue();

      return reply.send({
        success: true,
        data: { message: "Face extraction queue cleared" },
      });
    },
  );
}
