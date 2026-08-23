import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import ffmpeg from "fluent-ffmpeg";
import { authenticateUser } from "@/modules/auth/auth.middleware";
import { videosService } from "@/modules/videos/videos.service";
import { storyboardsService } from "@/modules/storyboards/storyboards.service";
import { idParamSchema } from "@/modules/videos/videos.schemas";
import { env } from "@/config/env";
import { editsService } from "./edits.service";
import { editsDemoService } from "./edits.demo.service";
import type { EditJob } from "./edits.types";
import {
  getProbeStreamDuration,
  getProbeStreamStart,
  type EditProbeStream,
} from "./edits.render-validation";
import {
  cancelEditJobResponseSchema,
  cloneEditJobBodySchema,
  createEditJobBodySchema,
  editingCapabilities,
  editingMetadataResponseSchema,
  editErrorResponseSchema,
  editJobListResponseSchema,
  editJobResponseSchema,
  jobDetailResponseSchema,
  listEditJobsQuerySchema,
} from "./edits.schemas";

const standardErrorResponses = {
  400: editErrorResponseSchema,
  401: editErrorResponseSchema,
  404: editErrorResponseSchema,
  409: editErrorResponseSchema,
  500: editErrorResponseSchema,
};

function serializeJobStatus(job: EditJob) {
  const streamUrl = job.outputVideoId
    ? `/api/videos/${job.outputVideoId}/stream`
    : undefined;

  return {
    job_id: job.id,
    status: job.status,
    progress: job.progress,
    started_at: job.startedAt,
    completed_at: job.completedAt,
    output:
      job.status === "completed"
        ? {
            directory_id: job.outputConfig.directory_id,
            video_id: job.outputVideoId,
            file_name: job.outputConfig.file_name,
            stream_url: streamUrl,
          }
        : undefined,
    error:
      job.status === "failed"
        ? {
            code: "RENDER_FAILED",
            message: "Video rendering failed",
          }
        : undefined,
  };
}

export async function videoEditsRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/:id/editing-metadata",
    {
      preHandler: authenticateUser,
      schema: {
        tags: ["edits"],
        summary: "Get editing metadata and capabilities",
        description:
          "Returns source metadata, storyboard availability, and the exact editing operations accepted by the render API.",
        params: idParamSchema,
        response: {
          200: editingMetadataResponseSchema,
          ...standardErrorResponses,
        },
      },
    },
    async (request) => {
      const { id } = request.params;

      if (env.DEMO_MODE) {
        const metadata = await editsDemoService.editingMetadata(id);
        return {
          success: true as const,
          data: {
            ...metadata,
            capabilities: editingCapabilities,
          },
        };
      }

      const video = await videosService.findById(id);
      const audioMeta = await new Promise<{
        present: boolean;
        codec: string | null;
        channels: number | null;
        sample_rate: number | null;
        start_time: number | null;
        duration: number | null;
        end_time: number | null;
        covers_video: boolean | null;
      }>((resolve) => {
        ffmpeg.ffprobe(video.file_path, (err, metadata) => {
          if (err) {
            resolve({
              present: video.audio_codec !== null,
              codec: video.audio_codec,
              channels: null,
              sample_rate: null,
              start_time: null,
              duration: null,
              end_time: null,
              covers_video: null,
            });
            return;
          }
          const audio = metadata.streams.find(
            (stream) => stream.codec_type === "audio"
          );
          const audioStart = audio
            ? getProbeStreamStart(audio as EditProbeStream)
            : null;
          const audioDuration = audio
            ? getProbeStreamDuration(audio as EditProbeStream)
            : null;
          const audioEnd =
            audioStart !== null && audioDuration !== null
              ? audioStart + audioDuration
              : null;
          const coversVideo = !audio
            ? false
            : audioStart !== null &&
                audioEnd !== null &&
                video.duration_seconds !== null
              ? audioStart <= 0.5 && audioEnd >= video.duration_seconds - 0.5
              : null;
          resolve({
            present: Boolean(audio),
            codec: audio?.codec_name ?? video.audio_codec,
            channels: audio?.channels ?? null,
            sample_rate: audio?.sample_rate
              ? Number.parseInt(audio.sample_rate.toString(), 10)
              : null,
            start_time: audioStart,
            duration: audioDuration,
            end_time: audioEnd,
            covers_video: coversVideo,
          });
        });
      });

      const storyboard = await storyboardsService.findByVideoId(id);

      return {
        success: true as const,
        data: {
          id: video.id,
          title: video.title,
          duration: video.duration_seconds,
          fps: video.fps,
          resolution: {
            width: video.width,
            height: video.height,
          },
          bitrate: video.bitrate,
          audio: audioMeta,
          storyboard_vtt: storyboard
            ? `/api/videos/${id}/thumbnails.vtt`
            : null,
          capabilities: editingCapabilities,
        },
      };
    }
  );

  app.post(
    "/:id/edits",
    {
      preHandler: authenticateUser,
      schema: {
        tags: ["edits"],
        summary: "Create edit job",
        description:
          "Validates and queues a single-source video edit. The Location header identifies the polling resource.",
        params: idParamSchema,
        body: createEditJobBodySchema,
        response: {
          202: editJobResponseSchema,
          ...standardErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      await videosService.findById(id);

      const job = await editsService.create(id, request.body);
      const location = `/api/edits/jobs/${job.id}`;

      return reply
        .code(202)
        .header("Location", location)
        .send({
          success: true as const,
          data: {
            job_id: job.id,
            status: job.status,
            video_id: job.videoId,
            output: {
              directory_id: job.outputConfig.directory_id,
              file_name: job.outputConfig.file_name,
            },
          },
          message: "Render job queued",
        });
    }
  );
}

export async function editsRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/jobs",
    {
      preHandler: authenticateUser,
      schema: {
        tags: ["edits"],
        summary: "List edit jobs",
        description:
          "Returns recent edit jobs for reload recovery, optionally filtered by source video or status.",
        querystring: listEditJobsQuerySchema,
        response: {
          200: editJobListResponseSchema,
          400: editErrorResponseSchema,
          401: editErrorResponseSchema,
          500: editErrorResponseSchema,
        },
      },
    },
    async (request) => {
      const { page, limit, video_id: videoId, status } = request.query;
      const result = await editsService.list({
        page,
        limit,
        videoId,
        status,
      });

      return {
        success: true as const,
        data: result.data.map((job) => ({
          ...serializeJobStatus(job),
          video_id: job.videoId,
          created_at: job.createdAt,
        })),
        pagination: result.pagination,
      };
    }
  );

  app.get(
    "/jobs/:id",
    {
      preHandler: authenticateUser,
      schema: {
        tags: ["edits"],
        summary: "Get edit job status",
        params: idParamSchema,
        response: {
          200: jobDetailResponseSchema,
          400: editErrorResponseSchema,
          401: editErrorResponseSchema,
          404: editErrorResponseSchema,
          500: editErrorResponseSchema,
        },
      },
    },
    async (request) => {
      const job = await editsService.getById(request.params.id);

      return {
        success: true as const,
        data: {
          ...serializeJobStatus(job),
          recipe: editsService.recipeFor(job),
        },
      };
    }
  );

  app.post(
    "/jobs/:id/clone",
    {
      preHandler: authenticateUser,
      schema: {
        tags: ["edits"],
        summary: "Clone a terminal edit job",
        description:
          "Queues a new edit using a terminal job as a recipe. A new output target is always required.",
        params: idParamSchema,
        body: cloneEditJobBodySchema,
        response: {
          202: editJobResponseSchema,
          ...standardErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const job = await editsService.clone(request.params.id, request.body);
      const location = `/api/edits/jobs/${job.id}`;

      return reply
        .code(202)
        .header("Location", location)
        .send({
          success: true as const,
          data: {
            job_id: job.id,
            status: job.status,
            video_id: job.videoId,
            output: {
              directory_id: job.outputConfig.directory_id,
              file_name: job.outputConfig.file_name,
            },
          },
          message: "Render job cloned and queued",
        });
    }
  );

  app.post(
    "/jobs/:id/cancel",
    {
      preHandler: authenticateUser,
      schema: {
        tags: ["edits"],
        summary: "Cancel edit job",
        description:
          "Cancels a queued or running job. Repeating cancellation for a terminal job is idempotent.",
        params: idParamSchema,
        response: {
          200: cancelEditJobResponseSchema,
          ...standardErrorResponses,
        },
      },
    },
    async (request) => {
      const job = await editsService.cancel(request.params.id);

      return {
        success: true as const,
        data: {
          job_id: job.id,
          status: job.status,
        },
      };
    }
  );
}
