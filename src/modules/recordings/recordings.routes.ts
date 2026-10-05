import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { API_PREFIX } from "@/config/constants";
import { env } from "@/config/env";
import { authenticateUser } from "@/modules/auth/auth.middleware";
import { goondvr } from "./recordings.goondvr";
import { RECORDER_SITES, demoChannelPicture, recorderService } from "./recordings.live";
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
const channelParams = z.object({ channelId: z.string().min(1).max(200) });
const channelInput = z.object({
  username: z.string().trim().min(1).max(200),
  site: z.enum(RECORDER_SITES),
  resolution: z.number().int().min(144).max(4320),
  framerate: z.number().int().min(1).max(240),
  split_minutes: z.number().int().min(0).max(24 * 60),
  split_mb: z.number().int().min(0).max(1024 * 1024),
  keep_minutes: z.number().int().min(0).max(10 * 365 * 24 * 60),
  keep_mb: z.number().int().min(0).max(100 * 1024 * 1024),
  auto_start: z.boolean().optional(),
});
const secret = z.string().max(8_000).optional();

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
        description: "The latest live frame, or with kind=summary the site's profile image.",
        params: channelParams,
        querystring: z.object({ kind: z.enum(["live", "summary"]).default("live"), v: z.string().max(40).optional() }),
      },
    },
    async (request, reply) => {
      if (env.DEMO_MODE) {
        const stand = await demoChannelPicture(request.params.channelId, request.query.kind);
        if (!stand) return reply.code(404).send({ success: false, error: { message: "No thumbnail", statusCode: 404 } });
        return reply.redirect(`${API_PREFIX}/creators/${stand.creatorId}/picture?variant=${stand.variant}`);
      }
      const upstream = await goondvr.thumbnail(request.params.channelId, request.query.kind);
      if (!upstream) return reply.code(404).send({ success: false, error: { message: "No thumbnail", statusCode: 404 } });
      reply.header("Content-Type", upstream.headers.get("content-type") ?? "image/jpeg");
      reply.header("Cache-Control", "private, max-age=30");
      return reply.send(Buffer.from(await upstream.arrayBuffer()));
    }
  );

  app.get(
    "/live",
    { schema: { tags: ["recordings"], summary: "GoondVR channels, disk and version", response: { 200: anyData } } },
    async () => ({ success: true as const, data: await recorderService.live() })
  );

  app.get(
    "/live/creators/:creatorId",
    {
      schema: {
        tags: ["recordings"],
        summary: "GoondVR channels of a creator",
        description: "Channels whose page one of the creator's social links points at, or named like the creator.",
        params: z.object({ creatorId: z.coerce.number().int().positive() }),
        response: { 200: anyData },
      },
    },
    async (request) => ({ success: true as const, data: await recorderService.forCreator(request.params.creatorId) })
  );

  app.post(
    "/live/channels",
    {
      schema: {
        tags: ["recordings"],
        summary: "Start recording a channel",
        description: "A pasted page URL or @handle is accepted as the username; GoondVR normalises it.",
        body: channelInput,
        response: { 200: anyData },
      },
    },
    async (request) => ({ success: true as const, data: await recorderService.add(request.body) })
  );

  app.put(
    "/live/channels/:channelId",
    {
      schema: {
        tags: ["recordings"],
        summary: "Change a channel's quality and limits",
        description: "GoondVR restarts the channel's monitor, finishing the file in progress first.",
        params: channelParams,
        body: channelInput,
        response: { 200: anyData },
      },
    },
    async (request) => ({ success: true as const, data: await recorderService.update(request.params.channelId, request.body) })
  );

  app.get(
    "/live/channels/:channelId/watch",
    {
      schema: {
        tags: ["recordings"],
        summary: "Where to play a channel live",
        description:
          "An HLS playlist relayed from GoondVR's in-memory live view (paused channels included, recording nothing); in the demo a demo video stands in.",
        params: channelParams,
        response: { 200: anyData },
      },
    },
    async (request) => ({ success: true as const, data: await recorderService.watch(request.params.channelId) })
  );

  app.get(
    "/live/channels/:channelId/stream/:file",
    {
      schema: {
        tags: ["recordings"],
        summary: "A channel's live HLS view (proxied)",
        description:
          "index.m3u8 and the segments it lists. 503 with Retry-After while the stream is starting, 404 when there is nothing to watch. Never in the demo.",
        params: channelParams.extend({ file: z.string().regex(/^(?:index\.m3u8|init-\d{1,9}\.mp4|seg-\d{1,12}\.(?:m4s|ts))$/) }),
      },
    },
    async (request, reply) => {
      const fail = (statusCode: number, message: string) => reply.code(statusCode).send({ success: false, error: { message, statusCode } });
      if (env.DEMO_MODE) return fail(404, "The demo never plays a real broadcast");
      const upstream = await goondvr.live(request.params.channelId, request.params.file);
      if (!upstream) return fail(502, "GoondVR is not reachable");
      if (!upstream.ok) {
        const body = (await upstream.json().catch(() => null)) as { error?: string } | null;
        if (upstream.status === 503) {
          reply.header("Retry-After", upstream.headers.get("retry-after") ?? "2");
          return fail(503, body?.error || "The live view is starting");
        }
        return fail(upstream.status >= 500 ? 502 : 404, body?.error || "Nothing to watch");
      }
      reply.header("Content-Type", upstream.headers.get("content-type") ?? "application/octet-stream");
      reply.header("Cache-Control", upstream.headers.get("cache-control") ?? "no-store");
      return reply.send(Buffer.from(await upstream.arrayBuffer()));
    }
  );

  app.post(
    "/live/channels/:channelId/pause",
    { schema: { tags: ["recordings"], summary: "Pause a channel", params: channelParams, response: { 200: anyData } } },
    async (request) => ({ success: true as const, data: await recorderService.pause(request.params.channelId) })
  );

  app.post(
    "/live/channels/:channelId/resume",
    {
      schema: {
        tags: ["recordings"],
        summary: "Resume a channel",
        description: "409 while one of the channel's own limits, or the disk, is still exhausted.",
        params: channelParams,
        response: { 200: anyData },
      },
    },
    async (request) => ({ success: true as const, data: await recorderService.resume(request.params.channelId) })
  );

  app.delete(
    "/live/channels/:channelId",
    {
      schema: {
        tags: ["recordings"],
        summary: "Stop recording a channel",
        description: "Removes the channel from GoondVR. Its recordings stay on disk.",
        params: channelParams,
        response: { 200: anyData },
      },
    },
    async (request) => ({ success: true as const, data: await recorderService.remove(request.params.channelId) })
  );

  app.post(
    "/live/channels/:channelId/creator",
    {
      schema: {
        tags: ["recordings"],
        summary: "Link a channel to a creator",
        description: "Adds the channel's page to an existing creator's links, or creates a creator (named after the channel unless a name is given).",
        params: channelParams,
        body: z.object({ creator_id: z.number().int().positive().optional(), name: z.string().trim().min(1).max(255).optional() }),
        response: { 200: anyData },
      },
    },
    async (request) => ({ success: true as const, data: await recorderService.linkCreator(request.params.channelId, request.body) })
  );

  app.get(
    "/live/settings",
    { schema: { tags: ["recordings"], summary: "GoondVR's global settings", response: { 200: anyData } } },
    async () => ({ success: true as const, data: await recorderService.settings() })
  );

  app.put(
    "/live/settings",
    {
      schema: {
        tags: ["recordings"],
        summary: "Change GoondVR's global settings",
        description: "Secrets are write-only: omit to keep, send an empty string to clear. GoondVR's own ffmpeg finalization is always kept off.",
        body: z.object({
          completed_dir: z.string().max(1000).optional(),
          disk_warning_percent: z.number().int().min(1).max(99).optional(),
          disk_critical_percent: z.number().int().min(2).max(100).optional(),
          cf_channel_threshold: z.number().int().min(1).max(1000).optional(),
          cf_global_threshold: z.number().int().min(1).max(1000).optional(),
          notify_cooldown_hours: z.number().int().min(1).max(24 * 30).optional(),
          notify_stream_online: z.boolean().optional(),
          cookies: secret,
          user_agent: secret,
          ntfy_url: secret,
          ntfy_topic: secret,
          ntfy_token: secret,
          discord_webhook_url: secret,
        }),
        response: { 200: anyData },
      },
    },
    async (request) => ({ success: true as const, data: await recorderService.updateSettings(request.body) })
  );

  app.get(
    "/:videoId",
    {
      schema: { tags: ["recordings"], summary: "Highlight review of a recording", params: videoParams, response: { 200: anyData } },
    },
    async (request) => ({ success: true as const, data: await recordingsService.review(request.user!.id, request.params.videoId) })
  );

  app.delete(
    "/:videoId",
    {
      schema: {
        tags: ["recordings"],
        summary: "Delete a recording",
        description: "Deletes the recording (through GoondVR when it owns the file) and its review. Refused while it is still being recorded or clips are rendering from it.",
        params: videoParams,
        response: { 200: anyData },
      },
    },
    async (request) => ({ success: true as const, data: await recordingsService.discard(request.user!.id, request.params.videoId) })
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
