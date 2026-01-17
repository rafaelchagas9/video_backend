import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { authenticateUser } from "@/modules/auth/auth.middleware";
import { storyboardsService } from "./storyboards.service";
import {
  idParamSchema,
  generateStoryboardBodySchema,
  storyboardResponseSchema,
  messageResponseSchema,
  errorResponseSchema,
} from "./storyboards.schemas";

export async function storyboardsRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // ========== PUBLIC ROUTES (no auth required) ==========
  // These are used by video players and need to be accessible without auth

  // Serve VTT file for video (Vidstack expects this)
  fastify.get(
    "/videos/:id/thumbnails.vtt",
    {
      schema: {
        tags: ["storyboards"],
        summary: "Get thumbnails VTT",
        description:
          "Returns the WebVTT file with storyboard sprite coordinates for Vidstack slider preview.",
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const vttContent = await storyboardsService.getVttContent(Number(id));

      reply.header("Content-Type", "text/vtt");
      reply.header("Cache-Control", "public, max-age=86400");
      return reply.send(vttContent);
    },
  );

  const spriteSchema = {
    tags: ["storyboards"],
    summary: "Get storyboard sprite",
    description:
      "Returns the storyboard sprite sheet image (JPEG or WebP) for slider preview thumbnails.",
  };

  const sendSprite = async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const spriteAsset = await storyboardsService.getSpriteAsset(Number(id));

    reply.header("Content-Type", spriteAsset.contentType);
    reply.header("Cache-Control", "public, max-age=86400");
    return reply.send(spriteAsset.buffer);
  };

  // Serve sprite image for video
  fastify.get(
    "/videos/:id/storyboard.jpg",
    {
      schema: spriteSchema,
    },
    sendSprite,
  );

  fastify.get(
    "/videos/:id/storyboard.webp",
    {
      schema: spriteSchema,
    },
    sendSprite,
  );

  // ========== AUTHENTICATED ROUTES ==========

  // Generate storyboard for video
  app.post(
    "/videos/:id/storyboard",
    {
      preHandler: authenticateUser,
      schema: {
        tags: ["storyboards"],
        summary: "Generate storyboard",
        description:
          "Generates a storyboard sprite sheet and VTT file for slider preview thumbnails.",
        params: idParamSchema,
        body: generateStoryboardBodySchema,
        response: {
          201: storyboardResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const storyboard = await storyboardsService.generate(
        request.params.id,
        request.body ?? undefined,
      );

      return reply.status(201).send({
        success: true,
        data: storyboard,
        message: "Storyboard generated successfully",
      });
    },
  );

  // Delete storyboard for video
  app.delete(
    "/videos/:id/storyboard",
    {
      preHandler: authenticateUser,
      schema: {
        tags: ["storyboards"],
        summary: "Delete storyboard",
        description:
          "Deletes the storyboard files and database record for a video.",
        params: idParamSchema,
        response: {
          200: messageResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      await storyboardsService.delete(request.params.id);

      return reply.send({
        success: true,
        message: "Storyboard deleted successfully",
      });
    },
  );

  // Get storyboard info for video
  app.get(
    "/videos/:id/storyboard",
    {
      preHandler: authenticateUser,
      schema: {
        tags: ["storyboards"],
        summary: "Get storyboard info",
        description: "Returns the storyboard metadata for a video.",
        params: idParamSchema,
        response: {
          200: storyboardResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const storyboard = await storyboardsService.findByVideoId(
        request.params.id,
      );

      if (!storyboard) {
        return reply.status(404).send({
          success: false,
          message: "Storyboard not found for this video",
        });
      }

      return reply.send({
        success: true,
        data: storyboard,
      });
    },
  );
}
