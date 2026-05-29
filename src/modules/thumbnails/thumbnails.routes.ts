import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { createReadStream } from "fs";
import { API_PREFIX } from "@/config/constants";
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

export async function videoThumbnailsRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // All routes require authentication
  app.addHook("preHandler", authenticateUser);

  const mapThumbnail = (thumbnail: Awaited<ReturnType<typeof thumbnailsService.findById>>) => ({
    ...thumbnail,
    asset_url: `${API_PREFIX}/thumbnails/${thumbnail.id}/image`,
  });

  // Generate thumbnail for video
  app.post(
    "/:id/thumbnails",
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
        data: mapThumbnail(thumbnail),
        message: "Thumbnail generated successfully",
      });
    },
  );

  // Get thumbnails for video
  app.get(
    "/:id/thumbnails",
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
        data: thumbnails.map(mapThumbnail),
      });
    },
  );
}

export async function thumbnailsRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // All routes require authentication
  app.addHook("preHandler", authenticateUser);

  const mapThumbnail = (thumbnail: Awaited<ReturnType<typeof thumbnailsService.findById>>) => ({
    ...thumbnail,
    asset_url: `${API_PREFIX}/thumbnails/${thumbnail.id}/image`,
  });

  app.get(
    "/:id",
    {
      schema: {
        tags: ["thumbnails"],
        summary: "Get thumbnail metadata",
        description:
          "Returns thumbnail metadata and the canonical asset URL for the binary image.",
        params: idParamSchema,
        response: {
          200: thumbnailResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const thumbnail = await thumbnailsService.findById(request.params.id);

      return reply.send({
        success: true,
        data: mapThumbnail(thumbnail),
      });
    },
  );

  // Serve thumbnail image (uses fastify directly for binary response)
  app.get(
    "/:id/image",
    {
      schema: {
        tags: ["thumbnails"],
        summary: "Get thumbnail image",
        description: "Serves the thumbnail image file.",
        params: idParamSchema,
      },
    },
    async (request, reply) => {
      const thumbnail = await thumbnailsService.findById(request.params.id);

      // Determine mime type from file extension
      const ext = thumbnail.file_path.split('.').pop()?.toLowerCase();
      const mimeType = ext === 'webp' ? 'image/webp' : 'image/jpeg';

      reply.header("Content-Type", mimeType);
      reply.header("Cache-Control", "public, max-age=86400");
      return reply.send(createReadStream(thumbnail.file_path));
    },
  );

  // Delete thumbnail
  app.delete(
    "/:id",
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
