import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import sharp from "sharp";
import { z } from "zod";
import { API_PREFIX } from "@/config/constants";
import { env } from "@/config/env";
import { authenticateUser } from "@/modules/auth/auth.middleware";
import { archiveAllFinished, archiveStatus, queueArchive } from "./recordings.archive";
import { recorderAutopilot } from "./recordings.autopilot";
import { AUTOPILOT_MODES } from "./recordings.autopilot.policy";
import { DISCARD_REASONS, REVIEW_PASSES } from "./recordings.feedback";
import { goondvr } from "./recordings.goondvr";
import { RECORDER_SITES, demoChannelPicture, recorderService } from "./recordings.live";
import { PROBE_STATES } from "./recordings.probe";
import { RECORDING_REFINEMENTS } from "@/database/schema";
import { answerLabelTask, listLabelTasks } from "./recordings.label-tasks";
import { recordingsService } from "./recordings.service";
import { recordingsProcessing } from "./recordings.processing";
import { liveSessions } from "./recordings.sessions";
import { CAPTURE_MODES } from "./recordings.sessions.policy";

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
  reasons: z.array(z.string().trim().min(1).max(60)).max(16).optional(),
  detected: z.object({ start_seconds: z.number().min(0), end_seconds: z.number().min(0) }).optional(),
  refinement: z.enum(RECORDING_REFINEMENTS).nullable().optional(),
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
          detector: z.enum(["trained", "prompts"]).optional(),
          highlight_states: z.array(z.enum(PROBE_STATES)).min(1).max(PROBE_STATES.length).optional(),
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
        ...(request.body.detector ? { detector: request.body.detector } : {}),
        ...(request.body.highlight_states ? { highlightStates: request.body.highlight_states } : {}),
      }),
    })
  );

  app.get(
    "/channels/:channelId/thumbnail",
    {
      schema: {
        tags: ["recordings"],
        summary: "Live thumbnail of a GoondVR channel (proxied)",
        description: "The latest live frame, or with kind=summary the site's profile image. With size, scaled to fit that square as WebP.",
        params: channelParams,
        querystring: z.object({
          kind: z.enum(["live", "summary"]).default("live"),
          v: z.string().max(40).optional(),
          size: z.coerce.number().int().min(32).max(1024).optional(),
        }),
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
      const image = Buffer.from(await upstream.arrayBuffer());
      // Profile images change rarely; live frames every few seconds.
      reply.header("Cache-Control", request.query.kind === "summary" ? "private, max-age=86400" : "private, max-age=30");
      if (request.query.size) {
        // Profile images arrive at full camera resolution (8K and 5 MB+); avatars need a sliver of that.
        const { size } = request.query;
        reply.header("Content-Type", "image/webp");
        return reply.send(await sharp(image).rotate().resize(size, size, { fit: "cover", withoutEnlargement: true }).webp({ quality: 80 }).toBuffer());
      }
      reply.header("Content-Type", upstream.headers.get("content-type") ?? "image/jpeg");
      return reply.send(image);
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
          "An HLS playlist relayed from GoondVR's in-memory live view (paused channels included, recording nothing); in the demo a demo video, looped as a live window, stands in.",
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
          "index.m3u8 and the segments it lists. 503 with Retry-After while the stream is starting, 404 when there is nothing to watch. In the demo, a demo video looped as a live window.",
        params: channelParams.extend({ file: z.string().regex(/^(?:index\.m3u8|init-\d{1,9}\.mp4|seg-\d{1,12}\.(?:m4s|ts))$/) }),
      },
    },
    async (request, reply) => {
      const fail = (statusCode: number, message: string) => reply.code(statusCode).send({ success: false, error: { message, statusCode } });
      if (env.DEMO_MODE) {
        const demo = await recorderService.demoLive(request.params.channelId, request.params.file);
        if (demo.kind === "starting") {
          reply.header("Retry-After", "2");
          return fail(503, "The live view is starting");
        }
        if (demo.kind === "missing") return fail(404, "Nothing to watch");
        reply.header("Content-Type", demo.contentType);
        reply.header("Cache-Control", "no-store");
        return reply.send(demo.body);
      }
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

  app.put(
    "/live/channels/:channelId/quality",
    {
      schema: {
        tags: ["recordings"],
        summary: "Pick the quality a paused channel is watched at",
        description:
          "A height the broadcast offers (`live.heights`), or 0 for the channel's own setting. A running live view restarts at it; 409 while the channel records, whose view plays the recording's quality.",
        params: channelParams,
        body: z.object({ height: z.number().int().min(0).max(4320) }),
        response: { 200: anyData },
      },
    },
    async (request) => ({ success: true as const, data: await recorderService.setLiveQuality(request.params.channelId, request.body.height) })
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
    "/processing",
    {
      schema: {
        tags: ["recordings"],
        summary: "Recording processing queue status",
        description: "Whether analysis of new recordings is running or paused, what is being processed and how many are waiting.",
        response: { 200: anyData },
      },
    },
    async () => ({ success: true as const, data: await recordingsProcessing.status() })
  );

  app.post(
    "/processing",
    {
      schema: {
        tags: ["recordings"],
        summary: "Pause, resume or start the recording processing queue",
        description: "resume and start are the same: both lift a pause and retry recordings that failed earlier.",
        body: z.object({ action: z.enum(["pause", "resume", "start"]) }),
        response: { 200: anyData },
      },
    },
    async (request) => {
      const { action } = request.body;
      const data = action === "pause" ? await recordingsProcessing.pause() : await recordingsProcessing.resume();
      return { success: true as const, data };
    }
  );

  app.get(
    "/autopilot",
    {
      schema: {
        tags: ["recordings"],
        summary: "Recorder autopilot status",
        description: "Settings, progress toward the classifier's data targets, the review queue, each channel's state and recent decisions.",
        response: { 200: anyData },
      },
    },
    async () => ({ success: true as const, data: await recorderAutopilot.status() })
  );

  app.put(
    "/autopilot/settings",
    {
      schema: {
        tags: ["recordings"],
        summary: "Change the recorder autopilot's settings",
        body: z.object({
          mode: z.enum(AUTOPILOT_MODES).optional(),
          defaultCapture: z.enum(CAPTURE_MODES).optional(),
          startThreshold: z.number().min(0.05).max(0.99).optional(),
          startReadings: z.number().int().min(1).max(10).optional(),
          idleStopMinutes: z.number().int().min(1).max(240).optional(),
          minRecordMinutes: z.number().int().min(0).max(240).optional(),
          queueLimit: z.number().int().min(1).max(1000).optional(),
          targets: z
            .object({
              pairedRecordings: z.number().int().min(0).max(100_000).optional(),
              channels: z.number().int().min(0).max(10_000).optional(),
              keeps: z.number().int().min(0).max(100_000).optional(),
            })
            .optional(),
          enoughUseful: z.number().int().min(1).max(1000).optional(),
          dropAfterEmpty: z.number().int().min(0).max(100).optional(),
          dropAfterReviewedWithoutKeep: z.number().int().min(0).max(100).optional(),
          defaultKeepMb: z.number().int().min(0).max(100 * 1024 * 1024).optional(),
          titleBlock: z.array(z.string().trim().min(1).max(60)).max(100).optional(),
          titlePrefer: z.array(z.string().trim().min(1).max(60)).max(100).optional(),
        }),
        response: { 200: anyData },
      },
    },
    async (request) => {
      const { targets, ...rest } = request.body;
      const current = await recorderAutopilot.settings();
      return {
        success: true as const,
        data: await recorderAutopilot.updateSettings({ ...rest, ...(targets ? { targets: { ...current.targets, ...targets } } : {}) }),
      };
    }
  );

  app.put(
    "/autopilot/channels/:channelId",
    {
      schema: {
        tags: ["recordings"],
        summary: "Set what Kura does with a channel's lives",
        description:
          "capture: manual | whole | highlights | training; threshold: the probability a moment needs to be kept in highlights mode (null for the default). The older `managed` toggle maps to manual or the default capture.",
        params: channelParams,
        body: z.union([
          z.object({ managed: z.boolean() }),
          z.object({ capture: z.enum(CAPTURE_MODES).optional(), threshold: z.number().min(0.05).max(0.99).nullable().optional() }),
        ]),
        response: { 200: anyData },
      },
    },
    async (request) => ({
      success: true as const,
      data:
        "managed" in request.body
          ? await recorderAutopilot.setManaged(request.params.channelId, request.body.managed)
          : await recorderAutopilot.setChannel(request.params.channelId, request.body),
    })
  );

  app.get(
    "/sessions",
    {
      schema: {
        tags: ["recordings"],
        summary: "Lives Kura followed",
        description: "Newest first: viewers over time, title changes, the site's info, and for highlights lives the cut and its video.",
        querystring: z.object({ channel_id: z.string().min(1).max(200).optional(), limit: z.coerce.number().int().min(1).max(200).optional() }),
        response: { 200: anyData },
      },
    },
    async (request) => ({ success: true as const, data: await liveSessions.list({ channelId: request.query.channel_id, limit: request.query.limit }) })
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
    "/feedback",
    {
      schema: {
        tags: ["recordings"],
        summary: "Review decisions so far",
        description: "How many highlights were kept, skipped or added, and how often each reason was given — the reasons people typed included.",
        response: { 200: anyData },
      },
    },
    async () => ({ success: true as const, data: await recordingsService.feedback() })
  );

  app.get(
    "/guide",
    {
      schema: {
        tags: ["recordings"],
        summary: "What to review, delete and record next",
        description: "Ranks the review queue by what it teaches the highlight model, flags fragments and edited compilations, names channels worth recording more (or enough of), and reports progress toward the training targets.",
        response: { 200: anyData },
      },
    },
    async (request) => ({ success: true as const, data: await recordingsService.guide(request.user!.id) })
  );

  app.get(
    "/archive",
    {
      schema: {
        tags: ["recordings"],
        summary: "Moving finished recordings to the NAS",
        description: "Whether the NAS archive folder is mounted, how many finished recordings are still on this disk, and the progress of moves in this server run.",
        response: { 200: anyData },
      },
    },
    async () => ({ success: true as const, data: await archiveStatus() })
  );

  app.post(
    "/archive",
    {
      schema: {
        tags: ["recordings"],
        summary: "Move every finished recording to the NAS",
        description: "Queues every recording whose review is finished (keeps rendered, or saved with nothing kept). Each gets a checksum-verified NAS copy with its labels before it leaves Kura.",
        response: { 200: anyData },
      },
    },
    async () => ({ success: true as const, data: await archiveAllFinished() })
  );

  app.post(
    "/:videoId/archive",
    {
      schema: {
        tags: ["recordings"],
        summary: "Move one finished recording to the NAS",
        params: z.object({ videoId: z.coerce.number().int().positive() }),
        response: { 200: anyData },
      },
    },
    async (request) => ({ success: true as const, data: { queued: queueArchive([request.params.videoId]) } })
  );

  app.get(
    "/label-tasks",
    {
      schema: {
        tags: ["recordings"],
        summary: "Labelling tasks outside the review queue",
        description: "Recall-audit windows and versus pairs within or across creators. A/B records a strict preference between two acceptable candidates; selected cuts are confirmed separately.",
        response: { 200: anyData },
      },
    },
    async () => ({ success: true as const, data: await listLabelTasks() })
  );

  app.put(
    "/label-tasks/:taskId",
    {
      schema: {
        tags: ["recordings"],
        summary: "Answer a labelling task",
        description: "keep or skip for a recall audit; a, b, both or neither for a versus pair, with each winner's best part; null reopens it.",
        params: z.object({ taskId: z.coerce.number().int().positive() }),
        body: z.object({
          answer: z.string().max(32).nullable(),
          reasons: z.array(z.string().trim().min(1).max(60)).max(16).optional(),
          detail: z
            .object({
              best: z
                .partialRecord(z.enum(["a", "b"]), z.object({ start_seconds: z.number().min(0), end_seconds: z.number().positive(), accepted: z.boolean() }))
                .optional(),
              viewing: z.partialRecord(z.enum(["a", "b"]), z.object({
                preview_started: z.array(z.number().int().min(0).max(2)).max(3),
                preview_completed: z.array(z.number().int().min(0).max(2)).max(3),
                full_opened: z.boolean(),
                full_completed: z.boolean(),
              })).optional(),
            })
            .optional(),
        }),
        response: { 200: anyData },
      },
    },
    async (request) => ({
      success: true as const,
      data: await answerLabelTask(request.params.taskId, request.body.answer, request.body.reasons ?? [], request.body.detail ?? null),
    })
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
        description: "Deletes the recording (through GoondVR when it owns the file) and its review. Refused while it is still being recorded or clips are rendering from it. `reason` says why: `nothing` records every undecided highlight as skipped; `desync` and `fragment` keep the content out of training.",
        params: videoParams,
        querystring: z.object({ reason: z.enum(DISCARD_REASONS).optional() }),
        response: { 200: anyData },
      },
    },
    async (request) => ({ success: true as const, data: await recordingsService.discard(request.user!.id, request.params.videoId, request.query.reason) })
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
        description:
          "Confirms every current choice. analyzed_at names the analysis being answered (a newer one is a conflict); queue_position and queue_sort say where the recording sat in the review queue; review_order which order its highlights were stepped through in; pass whether the kept clips are the highlights themselves (highlights) or only have potential (triage).",
        body: z.object({
          clips: z.array(clipSchema).max(60),
          analyzed_at: z.string().datetime().optional(),
          queue_position: z.number().int().min(0).max(10_000).optional(),
          queue_sort: z.string().trim().min(1).max(32).optional(),
          review_order: z.enum(["best", "timeline"]).optional(),
          pass: z.enum(REVIEW_PASSES).optional(),
        }),
        response: { 200: anyData },
      },
    },
    async (request) => ({
      success: true as const,
      data: await recordingsService.updateClips(request.user!.id, request.params.videoId, request.body.clips, {
        analyzedAt: request.body.analyzed_at,
        queuePosition: request.body.queue_position,
        queueSort: request.body.queue_sort,
        reviewOrder: request.body.review_order,
        pass: request.body.pass,
      }),
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
