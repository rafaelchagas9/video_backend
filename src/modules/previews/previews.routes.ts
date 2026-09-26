import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { authenticateUser } from "@/modules/auth/auth.middleware";
import { streamFile } from "@/modules/videos/streaming.service";
import { previewsService } from "./previews.service";

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });
const errorResponseSchema = z.object({
  success: z.literal(false),
  error: z.object({
    message: z.string(),
    statusCode: z.number(),
    details: z.unknown().optional(),
  }),
});
const previewSchema = z.object({
  video_id: z.number(),
  file_size_bytes: z.number(),
  duration_seconds: z.number(),
  clip_count: z.number(),
  width: z.number(),
  height: z.number(),
  has_audio: z.boolean(),
  generated_at: z.string(),
});
const statusSchema = z.object({
  video_id: z.number(),
  status: z.enum(["idle", "queued", "processing", "ready", "failed"]),
  updated_at: z.string().nullable(),
  error: z.string().optional(),
});

export async function previewsRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // Streams like /stream: range support so the browser can start and loop cheaply.
  app.get(
    "/:id/preview.mp4",
    {
      preHandler: authenticateUser,
      schema: {
        tags: ["previews"],
        summary: "Get hover preview",
        description:
          "Streams the short hover-preview teaser (AV1 + AAC MP4) with HTTP range support. 404 when none exists yet.",
        params: idParamSchema,
      },
    },
    async (request, reply) => {
      const path = await previewsService.getFilePath(request.params.id);
      const result = streamFile(path, request.headers.range, "video/mp4", {
        videoId: request.params.id,
        preview: true,
      });
      reply.header("Access-Control-Allow-Origin", request.headers.origin || "*");
      reply.header("Access-Control-Allow-Credentials", "true");
      reply.header(
        "Access-Control-Expose-Headers",
        "Content-Range, Accept-Ranges, Content-Length"
      );
      // Regeneration writes a new file; the client busts with ?v=generated_at.
      reply.header("Cache-Control", "private, max-age=86400");
      reply.status(result.statusCode);
      Object.entries(result.headers).forEach(([name, value]) =>
        reply.header(name, String(value))
      );
      return reply.send(result.stream);
    }
  );

  app.get(
    "/:id/preview",
    {
      preHandler: authenticateUser,
      schema: {
        tags: ["previews"],
        summary: "Get hover preview info",
        params: idParamSchema,
        response: {
          200: z.object({ success: z.literal(true), data: previewSchema }),
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const preview = await previewsService.findByVideoId(request.params.id);
      if (!preview)
        return reply.status(404).send({
          success: false as const,
          error: { message: "Preview not found for this video", statusCode: 404 },
        });
      return reply.send({ success: true as const, data: preview });
    }
  );

  app.get(
    "/:id/preview/status",
    {
      preHandler: authenticateUser,
      schema: {
        tags: ["previews"],
        summary: "Get hover preview generation status",
        params: idParamSchema,
        response: {
          200: z.object({ success: z.literal(true), data: statusSchema }),
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request) => ({
      success: true as const,
      data: await previewsService.getGenerationStatus(request.params.id),
    })
  );

  app.post(
    "/:id/preview",
    {
      preHandler: authenticateUser,
      schema: {
        tags: ["previews"],
        summary: "Generate hover preview",
        description:
          "Queues (re)generation of the hover preview and returns 202; poll /preview/status. Demo previews are pre-generated, so demo mode only reports status.",
        params: idParamSchema,
        response: {
          202: z.object({ success: z.literal(true), data: statusSchema }),
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      await previewsService.queueGenerate(request.params.id, true);
      return reply.status(202).send({
        success: true as const,
        data: await previewsService.getGenerationStatus(request.params.id),
      });
    }
  );

  app.delete(
    "/:id/preview",
    {
      preHandler: authenticateUser,
      schema: {
        tags: ["previews"],
        summary: "Delete hover preview",
        params: idParamSchema,
        response: {
          200: z.object({ success: z.boolean(), message: z.string() }),
          401: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      await previewsService.delete(request.params.id);
      return reply.send({ success: true, message: "Preview deleted" });
    }
  );
}
