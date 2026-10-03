import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { env } from "@/config/env";
import { authenticateUser } from "@/modules/auth/auth.middleware";
import { goondvr } from "./recordings.goondvr";
import { recordingsService } from "./recordings.service";

const videoParams = z.object({ videoId: z.coerce.number().int().positive() });
const clipSchema = z.object({
  id: z.string().min(1).max(32),
  start_seconds: z.number().min(0),
  end_seconds: z.number().positive(),
  peak_seconds: z.number().min(0),
  score: z.number(),
  label: z.string().max(300),
  keep: z.boolean(),
  job_id: z.number().int().nullable().optional(),
  output_video_id: z.number().int().nullable().optional(),
});
const anyData = z.object({ success: z.literal(true), data: z.any() });

export async function recordingsRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.addHook("preHandler", authenticateUser);

  app.get(
    "/",
    {
      schema: {
        tags: ["recordings"],
        summary: "Live channels and recordings awaiting highlight review",
        response: { 200: anyData },
      },
    },
    async (request) => ({ success: true as const, data: await recordingsService.overview(request.user!.id) })
  );

  app.get(
    "/settings",
    { schema: { tags: ["recordings"], summary: "Highlight detection settings", response: { 200: anyData } } },
    async () => ({ success: true as const, data: await recordingsService.settings() })
  );

  app.put(
    "/settings",
    {
      schema: {
        tags: ["recordings"],
        summary: "Update highlight detection settings",
        body: z.object({
          highlight_prompts: z.array(z.string().trim().min(1).max(200)).max(40).optional(),
          idle_prompts: z.array(z.string().trim().min(1).max(200)).max(40).optional(),
          sensitivity: z.number().min(0.5).max(4).optional(),
          directory_id: z.number().int().min(0).optional(),
        }),
        response: { 200: anyData },
      },
    },
    async (request) => ({
      success: true as const,
      data: await recordingsService.updateSettings({
        ...(request.body.highlight_prompts ? { highlightPrompts: request.body.highlight_prompts } : {}),
        ...(request.body.idle_prompts ? { idlePrompts: request.body.idle_prompts } : {}),
        ...(request.body.sensitivity !== undefined ? { sensitivity: request.body.sensitivity } : {}),
        ...(request.body.directory_id !== undefined ? { directoryId: request.body.directory_id } : {}),
      }),
    })
  );

  app.get(
    "/channels/:channelId/thumbnail",
    {
      schema: {
        tags: ["recordings"],
        summary: "Live thumbnail of a GoondVR channel (proxied)",
        params: z.object({ channelId: z.string().min(1).max(200) }),
      },
    },
    async (request, reply) => {
      const upstream = env.DEMO_MODE ? null : await goondvr.thumbnail(request.params.channelId);
      if (!upstream) return reply.code(404).send({ success: false, error: { message: "No thumbnail", statusCode: 404 } });
      reply.header("Content-Type", upstream.headers.get("content-type") ?? "image/jpeg");
      reply.header("Cache-Control", "private, max-age=30");
      return reply.send(Buffer.from(await upstream.arrayBuffer()));
    }
  );

  app.get(
    "/:videoId",
    {
      schema: { tags: ["recordings"], summary: "Highlight review of a recording", params: videoParams, response: { 200: anyData } },
    },
    async (request) => ({ success: true as const, data: await recordingsService.review(request.user!.id, request.params.videoId) })
  );

  app.post(
    "/:videoId/analyze",
    {
      schema: {
        tags: ["recordings"],
        summary: "Detect highlights in a recording",
        description: "Indexes the recording's frames if needed, then proposes clips from the highlight descriptions.",
        params: videoParams,
        response: { 200: anyData },
      },
    },
    async (request) => ({ success: true as const, data: await recordingsService.analyze(request.user!.id, request.params.videoId) })
  );

  app.put(
    "/:videoId/clips",
    {
      schema: {
        tags: ["recordings"],
        summary: "Save clip decisions",
        params: videoParams,
        body: z.object({ clips: z.array(clipSchema).max(60) }),
        response: { 200: anyData },
      },
    },
    async (request) => ({
      success: true as const,
      data: await recordingsService.updateClips(request.user!.id, request.params.videoId, request.body.clips),
    })
  );

  app.post(
    "/:videoId/render",
    {
      schema: {
        tags: ["recordings"],
        summary: "Render kept clips into the library",
        description: "Queues one edit job per kept clip, or with combine one job joining every kept stretch into a single video. With delete_original the recording is removed once every clip exists.",
        params: videoParams,
        body: z.object({ delete_original: z.boolean().default(false), combine: z.boolean().default(false) }),
        response: { 200: anyData },
      },
    },
    async (request) => ({
      success: true as const,
      data: await recordingsService.render(request.user!.id, request.params.videoId, request.body.delete_original, request.body.combine),
    })
  );
}
