import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { createReadStream } from "fs";
import { API_PREFIX } from "@/config/constants";
import { env } from "@/config/env";
import { resolveDemoAssetPath } from "@/database/demo/assets";
import { authenticateUser } from "@/modules/auth/auth.middleware";
import { thumbnailsService } from "./thumbnails.service";
import { sourceCoversService } from "@/modules/source-covers/source-covers.service";
import { sourceCoversDemoService } from "@/modules/source-covers/source-covers.demo.service";
import {
  idParamSchema,
  generateThumbnailSchema,
  thumbnailResponseSchema,
  thumbnailListResponseSchema,
  messageResponseSchema,
  errorResponseSchema,
} from "./thumbnails.schemas";

export async function videoThumbnailsRoutes(
  fastify: FastifyInstance
): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // All routes require authentication
  app.addHook("preHandler", authenticateUser);

  const mapThumbnail = (
    thumbnail: Awaited<ReturnType<typeof thumbnailsService.findById>>
  ) => ({
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
        request.body
      );

      return reply.status(201).send({
        success: true,
        data: mapThumbnail(thumbnail),
        message: "Thumbnail generated successfully",
      });
    }
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
        request.params.id
      );

      return reply.send({
        success: true,
        data: thumbnails.map(mapThumbnail),
      });
    }
  );
}

export async function thumbnailsRoutes(
  fastify: FastifyInstance
): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // All routes require authentication
  app.addHook("preHandler", authenticateUser);

  const mapThumbnail = (
    thumbnail: Awaited<ReturnType<typeof thumbnailsService.findById>>
  ) => ({
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
    }
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

      // A landscape scene cover beats the 640×480 ffmpeg frame wherever a
      // thumbnail is shown, without every list endpoint learning about covers.
      // The URL stays the same when a cover arrives, so revalidate by ETag.
      const cover = env.DEMO_MODE
        ? null
        : await sourceCoversService.get(thumbnail.video_id);
      const demoCover = env.DEMO_MODE
        ? await sourceCoversDemoService.thumbnail(thumbnail.video_id)
        : null;
      const version = cover?.thumbPath
        ? `cover-${cover.contentHash}`
        : demoCover
          ? `cover-${demoCover.byteLength}`
          : `frame-${thumbnail.generated_at}`;
      const etag = `"${version}"`;
      reply.header("Cache-Control", "private, no-cache");
      reply.header("ETag", etag);
      if (request.headers["if-none-match"] === etag)
        return reply.status(304).send();
      if (demoCover) return reply.type("image/webp").send(demoCover);
      if (cover?.thumbPath)
        return reply
          .type("image/webp")
          .send(createReadStream(cover.thumbPath));

      // Determine mime type from file extension
      const ext = thumbnail.file_path.split(".").pop()?.toLowerCase();
      const mimeType =
        ext === "png"
          ? "image/png"
          : ext === "webp"
            ? "image/webp"
            : "image/jpeg";

      reply.header("Content-Type", mimeType);
      const safePath = env.DEMO_MODE
        ? resolveDemoAssetPath(thumbnail.file_path, { mustExist: true })
        : thumbnail.file_path;
      return reply.send(createReadStream(safePath));
    }
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
    }
  );
}
