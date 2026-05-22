import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import ffmpeg from "fluent-ffmpeg";
import { authenticateUser } from "@/modules/auth/auth.middleware";
import { editsService } from "./edits.service";
import { videosService } from "@/modules/videos/videos.service";
import { storyboardsService } from "@/modules/storyboards/storyboards.service";
import { idParamSchema } from "@/modules/videos/videos.schemas";
import {
  createEditJobBodySchema,
  editJobResponseSchema,
  jobStatusResponseSchema,
  editingMetadataResponseSchema,
  editJobStatusSchema,
} from "./edits.schemas";
import { z } from "zod";

export async function editsRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // 2. Fetch Video Metadata For Editor
  app.get(
    "/videos/:id/editing-metadata",
    {
      preHandler: authenticateUser,
      schema: {
        tags: ["edits"],
        summary: "Get editing metadata",
        params: idParamSchema,
        response: {
          200: editingMetadataResponseSchema,
        },
      },
    },
    async (request) => {
      const { id } = request.params;
      const video = await videosService.findById(id);

      // Get audio metadata via ffprobe
      const audioMeta = await new Promise<{
        channels: number | null;
        sample_rate: number | null;
      }>((resolve) => {
        ffmpeg.ffprobe(video.file_path, (err, metadata) => {
          if (err) {
            resolve({ channels: null, sample_rate: null });
            return;
          }
          const audio = metadata.streams.find((s) => s.codec_type === "audio");
          resolve({
            channels: audio?.channels ?? null,
            sample_rate: audio?.sample_rate
              ? parseInt(audio.sample_rate.toString())
              : null,
          });
        });
      });

      // Get storyboard VTT
      const storyboard = await storyboardsService.findByVideoId(id);

      // Construct VTT URL (assuming endpoint /api/videos/:id/thumbnails.vtt)
      // Actually storyboards.routes.ts exposes: /videos/:id/thumbnails.vtt
      const storyboardVtt = storyboard
        ? `/api/videos/${id}/thumbnails.vtt`
        : null;

      return {
        success: true,
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
          storyboard_vtt: storyboardVtt,
        },
      };
    },
  );

  // 3. Create Render Job
  app.post(
    "/videos/:id/edits",
    {
      preHandler: authenticateUser,
      schema: {
        tags: ["edits"],
        summary: "Create edit job",
        params: idParamSchema,
        body: createEditJobBodySchema,
        response: {
          200: editJobResponseSchema,
        },
      },
    },
    async (request) => {
      const { id } = request.params;
      // Verify video exists
      await videosService.findById(id);

      const job = await editsService.create(id, request.body);

      return {
        success: true,
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
      };
    },
  );

  // 4. Check Render Job Status
  app.get(
    "/edits/jobs/:id",
    {
      preHandler: authenticateUser,
      schema: {
        tags: ["edits"],
        summary: "Get job status",
        params: idParamSchema,
        response: {
          200: jobStatusResponseSchema,
        },
      },
    },
    async (request) => {
      const { id } = request.params;
      const job = await editsService.getById(id);

      // Determine stream URL if completed and registered
      // For now, if we have outputVideoId, we assume it's /videos/:id/stream (standard pattern)
      const streamUrl = job.outputVideoId
        ? `/videos/${job.outputVideoId}/stream`
        : undefined;

      return {
        success: true,
        data: {
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
                  message: job.errorMessage || "Unknown error",
                }
              : undefined,
        },
      };
    },
  );

  // 5. Cancel Render Job
  app.post(
    "/edits/jobs/:id/cancel",
    {
      preHandler: authenticateUser,
      schema: {
        tags: ["edits"],
        summary: "Cancel edit job",
        params: idParamSchema,
        response: {
          200: z.object({
            success: z.boolean(),
            data: z.object({
              job_id: z.number(),
              status: editJobStatusSchema,
            }),
          }),
        },
      },
    },
    async (request) => {
      const { id } = request.params;
      const job = await editsService.cancel(id);

      return {
        success: true,
        data: {
          job_id: job.id,
          status: job.status,
        },
      };
    },
  );
}
