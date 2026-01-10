import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { readFileSync } from "fs";
import { authenticateUser } from "@/modules/auth/auth.middleware";
import { thumbnailsService } from "./thumbnails.service";
import {
  idParamSchema,
  generateThumbnailSchema,
  thumbnailResponseSchema,
  thumbnailListResponseSchema,
  messageResponseSchema,
  errorResponseSchema,
} from "./thumbnails.schemas";

export async function thumbnailsRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // All routes require authentication
  app.addHook("preHandler", authenticateUser);

  // Generate thumbnail for video
  app.post(
    "/videos/:id/thumbnails",
    {
      schema: {
        tags: ["thumbnails"],
        summary: "Generate thumbnail",
        description:
          "Generates a thumbnail for a video at the specified timestamp.",
        params: idParamSchema,
        body: generateThumbnailSchema,
        response: {
          201: thumbnailResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const thumbnail = await thumbnailsService.generate(
        request.params.id,
        request.body,
      );

      return reply.status(201).send({
        success: true,
        data: thumbnail,
        message: "Thumbnail generated successfully",
      });
    },
  );

  // Get thumbnails for video
  app.get(
    "/videos/:id/thumbnails",
    {
      schema: {
        tags: ["thumbnails"],
        summary: "Get video thumbnails",
        description: "Returns all thumbnails for a video.",
        params: idParamSchema,
        response: {
          200: thumbnailListResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const thumbnails = await thumbnailsService.getByVideoId(
        request.params.id,
      );

      return reply.send({
        success: true,
        data: thumbnails,
      });
    },
  );

  // Serve thumbnail image (uses fastify directly for binary response)
  fastify.get(
    "/thumbnails/:id/image",
    {
      schema: {
        tags: ["thumbnails"],
        summary: "Get thumbnail image",
        description: "Serves the thumbnail image file.",
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const thumbnail = await thumbnailsService.findById(Number(id));

      // Determine mime type from file extension
      const ext = thumbnail.file_path.split('.').pop()?.toLowerCase();
      const mimeType = ext === 'webp' ? 'image/webp' : 'image/jpeg';

      reply.header("Content-Type", mimeType);
      const buffer = readFileSync(thumbnail.file_path);
      return reply.send(buffer);
    },
  );

  // Delete thumbnail
  app.delete(
    "/thumbnails/:id",
    {
      schema: {
        tags: ["thumbnails"],
        summary: "Delete thumbnail",
        description: "Deletes a thumbnail file and database record.",
        params: idParamSchema,
        response: {
          200: messageResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      await thumbnailsService.delete(request.params.id);

      return reply.send({
        success: true,
        message: "Thumbnail deleted successfully",
      });
    },
  );
}
