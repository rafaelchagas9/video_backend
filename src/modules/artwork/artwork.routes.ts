import { createHash } from "crypto";
import { readFile } from "fs/promises";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import sharp from "sharp";
import { authenticateUser } from "@/modules/auth/auth.middleware";
import { NotFoundError } from "@/utils/errors";
import { artworkService } from "./artwork.service";
import {
  artworkImageQuerySchema,
  batchArtworkResponseSchema,
  batchGenerateArtworkSchema,
  errorResponseSchema,
  generateArtworkSchema,
  idParamSchema,
  messageResponseSchema,
  videoArtworkResponseSchema,
} from "./artwork.schemas";

export async function videoArtworkRoutes(
  fastify: FastifyInstance
): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.addHook("preHandler", authenticateUser);

  app.get(
    "/:id/artwork",
    {
      schema: {
        tags: ["artwork"],
        summary: "Get video artwork",
        params: idParamSchema,
        response: {
          200: videoArtworkResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) =>
      reply.send({
        success: true,
        data: await artworkService.getByVideoId(request.params.id),
      })
  );

  app.post(
    "/:id/artwork",
    {
      schema: {
        tags: ["artwork"],
        summary: "Generate video artwork",
        params: idParamSchema,
        body: generateArtworkSchema,
        response: {
          202: videoArtworkResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const artwork = await artworkService.requestGeneration(
        request.params.id,
        request.body
      );
      return reply.status(202).send({ success: true, data: artwork });
    }
  );

  app.delete(
    "/:id/artwork",
    {
      schema: {
        tags: ["artwork"],
        summary: "Delete video artwork",
        params: idParamSchema,
        response: {
          200: messageResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      await artworkService.deleteByVideoId(request.params.id);
      return reply.send({
        success: true,
        message: "Artwork deleted successfully",
      });
    }
  );
}

export async function artworkRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.addHook("preHandler", authenticateUser);

  app.post(
    "/batch",
    {
      schema: {
        tags: ["artwork"],
        summary: "Generate artwork in batch",
        body: batchGenerateArtworkSchema,
        response: { 202: batchArtworkResponseSchema, 401: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const videoIds = await artworkService.requestBatch(request.body);
      return reply.status(202).send({
        success: true,
        data: { queued: videoIds.length, video_ids: videoIds },
      });
    }
  );

  app.get(
    "/:id/image",
    {
      schema: {
        tags: ["artwork"],
        summary: "Get artwork image",
        params: idParamSchema,
        querystring: artworkImageQuerySchema,
      },
    },
    async (request, reply) => {
      const asset = await artworkService.getAssetById(request.params.id);
      if (request.query.h && request.query.h !== asset.contentHash) {
        throw new NotFoundError("Artwork asset version not found");
      }
      const requestedFormat = request.query.format;
      const extension = asset.filePath.split(".").pop()?.toLowerCase();
      const storedFormat =
        extension === "png"
          ? "png"
          : asset.variant === "title"
            ? "png"
            : "webp";
      const outputFormat = requestedFormat ?? storedFormat;
      const etagKey = `${asset.contentHash}:${request.query.w ?? "original"}:${outputFormat}`;
      const etag = `"${createHash("sha256").update(etagKey).digest("hex").slice(0, 24)}"`;
      reply.header("Cache-Control", "public, max-age=31536000, immutable");
      reply.header("ETag", etag);
      if (request.headers["if-none-match"] === etag)
        return reply.status(304).send();

      let buffer: Buffer<ArrayBufferLike> = await readFile(asset.filePath);
      let contentType = storedFormat === "png" ? "image/png" : "image/webp";
      if (request.query.w || requestedFormat) {
        let pipeline = sharp(buffer);
        if (request.query.w) {
          const longEdge = Math.max(asset.width, asset.height);
          const target = Math.min(longEdge, request.query.w);
          pipeline =
            asset.width >= asset.height
              ? pipeline.resize({ width: target, withoutEnlargement: true })
              : pipeline.resize({ height: target, withoutEnlargement: true });
        }
        switch (outputFormat) {
          case "avif":
            buffer = await pipeline.avif({ quality: 75 }).toBuffer();
            contentType = "image/avif";
            break;
          case "jpg":
            buffer = await pipeline.jpeg({ quality: 86 }).toBuffer();
            contentType = "image/jpeg";
            break;
          case "png":
            buffer = await pipeline.png().toBuffer();
            contentType = "image/png";
            break;
          default:
            buffer = await pipeline.webp({ quality: 84 }).toBuffer();
            contentType = "image/webp";
        }
      }
      return reply.type(contentType).send(buffer);
    }
  );
}
