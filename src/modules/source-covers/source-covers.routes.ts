import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { createReadStream } from "fs";
import { z } from "zod";
import { env } from "@/config/env";
import { authenticateUser } from "@/modules/auth/auth.middleware";
import { NotFoundError } from "@/utils/errors";
import { sourceCoversDemoService } from "./source-covers.demo.service";
import { sourceCoversService } from "./source-covers.service";

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

const coverSchema = z.object({
  video_id: z.number(),
  url: z.string(),
  source_url: z.string(),
  width: z.number(),
  height: z.number(),
  file_size_bytes: z.number(),
  serves_thumbnail: z.boolean(),
  fetched_at: z.string(),
});

function mimeOf(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  return ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
}

/** A video's stored scene cover: what it is, and the file itself. */
export async function sourceCoversRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.addHook("preHandler", authenticateUser);

  app.get(
    "/:id/cover",
    {
      schema: {
        tags: ["videos"],
        summary: "Get the video's stored scene cover",
        description:
          "The ThePornDB / StashDB cover kept on disk for this video, with its size, or null when artwork comes from a video frame.",
        params: idParamSchema,
        response: { 200: z.object({ success: z.literal(true), data: coverSchema.nullable() }) },
      },
    },
    async (request, reply) =>
      reply.send({ success: true, data: await sourceCoversService.describe(request.params.id) })
  );

  app.get(
    "/:id/cover/image",
    {
      schema: {
        tags: ["videos"],
        summary: "Serve the video's stored scene cover",
        params: idParamSchema,
        querystring: z.object({
          h: z.string().max(64).optional(),
          /** Demo only: one of the fixture's cover files for this video. */
          file: z.string().max(128).optional(),
        }),
      },
    },
    async (request, reply) => {
      const path = env.DEMO_MODE
        ? sourceCoversDemoService.resolveFile(request.params.id, request.query.file)
        : (await sourceCoversService.get(request.params.id))?.filePath ?? null;
      if (!path) throw new NotFoundError("This video has no stored cover");
      reply.header("Content-Type", mimeOf(path));
      // URLs carry the content hash (or demo file name), so a new cover is a new URL.
      reply.header("Cache-Control", "private, max-age=31536000, immutable");
      return reply.send(createReadStream(path));
    }
  );
}
