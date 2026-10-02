import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { API_PREFIX } from "@/config/constants";
import { authenticateUser } from "@/modules/auth/auth.middleware";
import { NotFoundError } from "@/utils/errors";
import { storyboardsService } from "./storyboards.service";
import {
  idParamSchema,
  generateStoryboardBodySchema,
  storyboardResponseSchema,
  thumbnailsVttQuerySchema,
  messageResponseSchema,
  errorResponseSchema,
  generationQuerySchema,
  generationStatusResponseSchema,
} from "./storyboards.schemas";

export async function storyboardsRoutes(
  fastify: FastifyInstance
): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const mapStoryboard = (
    storyboard: Awaited<ReturnType<typeof storyboardsService.findById>>
  ) => {
    const extension = storyboard.sprite_path.split(".").pop()?.toLowerCase();
    const spriteExtension = extension === "webp" ? "webp" : "jpg";

    return {
      ...storyboard,
      sprite_url: `${API_PREFIX}/videos/${storyboard.video_id}/storyboard.${spriteExtension}?v=${encodeURIComponent(storyboard.generated_at)}`,
      vtt_url: `${API_PREFIX}/videos/${storyboard.video_id}/thumbnails.vtt?v=${encodeURIComponent(storyboard.generated_at)}`,
    };
  };

  // ========== PUBLIC ROUTES (no auth required) ==========
  // These are used by video players and need to be accessible without auth

  // Serve VTT file for video (Vidstack expects this)
  fastify.get(
    "/:id/thumbnails.vtt",
    {
      schema: {
        tags: ["storyboards"],
        summary: "Get thumbnails VTT",
        description:
          "Returns the WebVTT file with storyboard sprite coordinates for Vidstack slider preview. If not available and autogenerate=true, generation is queued and 404 is returned until ready.",
        params: idParamSchema,
        querystring: thumbnailsVttQuerySchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { autogenerate } = request.query as {
        autogenerate?: boolean | string;
      };
      const shouldAutogenerate =
        autogenerate === undefined
          ? false
          : typeof autogenerate === "string"
            ? autogenerate.toLowerCase() === "true"
            : autogenerate;

      try {
        const vttContent = await storyboardsService.getVttContent(Number(id));

        reply.header("Content-Type", "text/vtt");
        reply.header("Cache-Control", "public, max-age=86400");
        return reply.send(vttContent);
      } catch (error) {
        if (shouldAutogenerate && error instanceof NotFoundError) {
          await storyboardsService.queueGenerate(Number(id));
        }

        throw error;
      }
    }
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
    "/:id/storyboard.jpg",
    {
      schema: spriteSchema,
    },
    sendSprite
  );

  fastify.get(
    "/:id/storyboard.webp",
    {
      schema: spriteSchema,
    },
    sendSprite
  );

  // One page of a paged storyboard, as referenced by the VTT cues.
  fastify.get(
    "/:id/storyboard/pages/:page",
    {
      schema: {
        tags: ["storyboards"],
        summary: "Get storyboard page",
        description:
          "Returns one page (at most 5×5 tiles) of a paged storyboard, e.g. /storyboard/pages/3.webp.",
      },
    },
    async (request, reply) => {
      const { id, page } = request.params as { id: string; page: string };
      const match = /^(\d{1,5})\.(webp|jpg)$/.exec(page);
      if (!match || !/^\d+$/.test(id))
        throw new NotFoundError("Storyboard page not found");
      const asset = await storyboardsService.getPageAsset(
        Number(id),
        Number(match[1])
      );
      reply.header("Content-Type", asset.contentType);
      reply.header("Cache-Control", "public, max-age=86400");
      return reply.send(asset.buffer);
    }
  );

  // ========== AUTHENTICATED ROUTES ==========

  // Generate storyboard for video
  app.post(
    "/:id/storyboard",
    {
      preHandler: authenticateUser,
      schema: {
        tags: ["storyboards"],
        summary: "Generate storyboard",
        description:
          "Generates a storyboard sprite sheet and VTT file. With background=true, returns 202 immediately; poll GET /api/videos/:id/storyboard/status for completion. Existing requests without this option wait and return 201.",
        params: idParamSchema,
        body: generateStoryboardBodySchema,
        querystring: generationQuerySchema,
        response: {
          201: storyboardResponseSchema,
          202: generationStatusResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (request.query.background === "true") {
        await storyboardsService.queueGenerate(
          request.params.id,
          request.body,
          true
        );
        return reply.status(202).send({
          success: true,
          data: await storyboardsService.getGenerationStatus(request.params.id),
        });
      }
      const storyboard = await storyboardsService.generate(
        request.params.id,
        request.body ?? undefined
      );

      return reply.status(201).send({
        success: true,
        data: mapStoryboard(storyboard),
        message: "Storyboard generated successfully",
      });
    }
  );

  app.get(
    "/:id/storyboard/status",
    {
      preHandler: authenticateUser,
      schema: {
        tags: ["storyboards"],
        summary: "Get storyboard generation status",
        description:
          "Reports queued/running work in this server process, its latest result, or an existing storyboard. After a server restart unfinished work reports idle (or ready if an older storyboard exists).",
        params: idParamSchema,
        response: {
          200: generationStatusResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request) => ({
      success: true as const,
      data: await storyboardsService.getGenerationStatus(request.params.id),
    })
  );

  // Delete storyboard for video
  app.delete(
    "/:id/storyboard",
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
    }
  );

  // Get storyboard info for video
  app.get(
    "/:id/storyboard",
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
        request.params.id
      );

      if (!storyboard) {
        return reply.status(404).send({
          success: false,
          error: {
            message: "Storyboard not found for this video",
            statusCode: 404,
          },
        });
      }

      return reply.send({
        success: true,
        data: mapStoryboard(storyboard),
      });
    }
  );
}
