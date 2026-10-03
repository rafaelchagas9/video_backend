import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { authenticateUser } from "@/modules/auth/auth.middleware";
import { videoSchema } from "@/modules/videos/videos.schemas";
import { videosService } from "@/modules/videos/videos.service";
import { discoveryService } from "./discovery.service";
import { watchHeatService } from "./watch-heat.service";

const peakSchema = z.object({
  start_seconds: z.number(),
  end_seconds: z.number(),
  peak_seconds: z.number(),
  intensity: z.number(),
});

const today = () => new Date().toISOString().slice(0, 10);

export async function discoveryRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.addHook("preHandler", authenticateUser);

  app.get(
    "/home",
    {
      schema: {
        tags: ["discovery"],
        summary: "Rediscovery sections for the home page",
        description:
          "Rails built from watch history: unseen videos by creators you watch, replay peaks you have not revisited, quiet favourites, barely explored catalogues and forgotten additions. Stable for a seed (default: today).",
        querystring: z.object({ seed: z.string().max(64).optional() }),
        response: {
          200: z.object({
            success: z.literal(true),
            data: z.object({
              sections: z.array(
                z.object({
                  id: z.string(),
                  title: z.string(),
                  subtitle: z.string().optional(),
                  items: z.array(
                    z.object({
                      video_id: z.number(),
                      reason: z.string(),
                      start_seconds: z.number().optional(),
                    })
                  ),
                })
              ),
              videos: z.array(videoSchema),
            }),
          }),
        },
      },
    },
    async (request) => ({
      success: true as const,
      data: await discoveryService.home(request.user!.id, request.query.seed ?? today()),
    })
  );

  app.get(
    "/moments",
    {
      schema: {
        tags: ["discovery"],
        summary: "A feed of short moments to play back to back",
        description:
          "mix = bookmarks + replay peaks, shuffled by seed; query = moments matching a visual description, best first.",
        querystring: z.object({
          mode: z.enum(["mix", "bookmarks", "replayed", "query"]).default("mix"),
          q: z.string().trim().min(1).max(300).optional(),
          creator_id: z.coerce.number().int().positive().optional(),
          seed: z.string().max(64).optional(),
          offset: z.coerce.number().int().min(0).default(0),
          limit: z.coerce.number().int().min(1).max(30).default(12),
        }),
        response: {
          200: z.object({
            success: z.literal(true),
            data: z.object({
              items: z.array(
                z.object({
                  id: z.string(),
                  video_id: z.number(),
                  start_seconds: z.number(),
                  end_seconds: z.number(),
                  peak_seconds: z.number(),
                  source: z.enum(["bookmark", "replayed", "visual"]),
                  label: z.string().nullable(),
                })
              ),
              videos: z.array(videoSchema),
              total: z.number(),
              next_offset: z.number().nullable(),
            }),
          }),
        },
      },
    },
    async (request) => ({
      success: true as const,
      data: await discoveryService.moments(request.user!.id, {
        mode: request.query.q && request.query.mode === "mix" ? "query" : request.query.mode,
        query: request.query.q,
        creatorId: request.query.creator_id,
        seed: request.query.seed ?? today(),
        offset: request.query.offset,
        limit: request.query.limit,
      }),
    })
  );

  app.get(
    "/videos/:id/heatmap",
    {
      schema: {
        tags: ["discovery"],
        summary: "Replay heat of a video",
        description:
          "How often each stretch has been watched, as a normalised curve over the whole duration, plus its distinct peaks.",
        params: z.object({ id: z.coerce.number().int().positive() }),
        response: {
          200: z.object({
            success: z.literal(true),
            data: z.object({
              video_id: z.number(),
              point_seconds: z.number(),
              curve: z.array(z.number()),
              peaks: z.array(peakSchema),
              watched_seconds: z.number(),
              meaningful: z.boolean(),
            }),
          }),
        },
      },
    },
    async (request) => {
      const video = await videosService.findById(request.params.id, request.user!.id);
      return {
        success: true as const,
        data: await watchHeatService.heatmap(video.id, video.duration_seconds ?? 0),
      };
    }
  );
}
