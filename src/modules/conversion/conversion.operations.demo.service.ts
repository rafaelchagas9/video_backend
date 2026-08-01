import { listPresets } from "@/config/presets";
import { demoRepository } from "@/database/demo";
import { BadRequestError, NotFoundError } from "@/utils/errors";
import { calculateTargetResolution } from "./conversion.planning";
import type {
  ConversionJob,
  CreateConversionJobInput,
} from "./conversion.types";

const RESOURCE_KIND = "conversion-job";
const DEMO_TIMESTAMP = "2026-01-01T12:00:00.000Z";

type DemoConversionJob = ConversionJob & { video_title: string };

/** SQLite-only conversion state machine; it never starts Redis or FFmpeg. */
export class ConversionOperationsDemoService {
  async createJob(input: CreateConversionJobInput): Promise<ConversionJob> {
    const preset = listPresets().find(
      (candidate) => candidate.id === input.preset
    );
    if (!preset) throw new BadRequestError(`Invalid preset: ${input.preset}`);

    const video = demoRepository.getVideoById(input.video_id);
    const duplicate = this.jobs().find(
      (job) =>
        job.video_id === input.video_id &&
        job.preset === input.preset &&
        ["pending", "processing"].includes(job.status)
    );
    if (duplicate) {
      throw new BadRequestError(
        `Conversion job already ${duplicate.status} for this video with preset ${input.preset}`
      );
    }

    const id = this.nextId();
    const extension = preset.container || "mkv";
    const job: DemoConversionJob = {
      id,
      video_id: input.video_id,
      video_title: video.title ?? video.file_name,
      status: "pending",
      preset: input.preset,
      target_resolution: calculateTargetResolution(
        video.width,
        video.height,
        preset
      ),
      codec: preset.codec,
      output_path: `/demo-generated/conversions/video-${input.video_id}-${input.preset}.${extension}`,
      output_size_bytes: null,
      progress_percent: 0,
      error_message: null,
      ffmpeg_output: null,
      delete_original: input.deleteOriginal ?? false,
      batch_id: input.batchId ?? null,
      created_at: DEMO_TIMESTAMP,
      started_at: null,
      completed_at: null,
    };
    demoRepository.putResource(RESOURCE_KIND, id, job);
    return job;
  }

  async bulkCreateJobs(input: {
    videoIds: number[];
    preset: string;
    deleteOriginal?: boolean;
    batchId?: string;
  }): Promise<ConversionJob[]> {
    const jobs: ConversionJob[] = [];
    for (const videoId of input.videoIds) {
      try {
        jobs.push(
          await this.createJob({
            video_id: videoId,
            preset: input.preset,
            deleteOriginal: input.deleteOriginal,
            batchId: input.batchId,
          })
        );
      } catch (error) {
        if (!(error instanceof BadRequestError)) throw error;
      }
    }
    return jobs;
  }

  async findById(id: number): Promise<ConversionJob> {
    const job = demoRepository.getResource(
      RESOURCE_KIND,
      id
    ) as DemoConversionJob | null;
    if (!job) throw new NotFoundError(`Conversion job not found: ${id}`);
    return job;
  }

  async listByVideoId(videoId: number): Promise<ConversionJob[]> {
    return this.jobs().filter((job) => job.video_id === videoId);
  }

  async cancel(id: number): Promise<ConversionJob> {
    const job = (await this.findById(id)) as DemoConversionJob;
    if (!["pending", "processing"].includes(job.status)) {
      throw new BadRequestError(`Cannot cancel job with status: ${job.status}`);
    }
    const cancelled: DemoConversionJob = {
      ...job,
      status: "cancelled",
      completed_at: DEMO_TIMESTAMP,
    };
    demoRepository.putResource(RESOURCE_KIND, id, cancelled);
    return cancelled;
  }

  async delete(id: number): Promise<void> {
    const job = await this.findById(id);
    if (["pending", "processing"].includes(job.status)) {
      throw new BadRequestError("Cannot delete an active conversion job");
    }
    demoRepository.deleteResource(RESOURCE_KIND, id);
  }

  getPresets() {
    return listPresets();
  }

  async getQueue(_userId = 1): Promise<ConversionJob[]> {
    return this.jobs().filter((job) =>
      ["pending", "processing"].includes(job.status)
    );
  }

  async getActiveConversions() {
    return ((await this.getQueue()) as DemoConversionJob[]).map((job) => ({
      id: job.id,
      video_id: job.video_id,
      video_title: job.video_title,
      preset: job.preset,
      status: job.status as "pending" | "processing",
      progress_percent: job.progress_percent,
      started_at: job.started_at,
      created_at: job.created_at,
    }));
  }

  async getQueueStatus() {
    const jobs = await this.getQueue();
    return {
      queueLength: jobs.filter((job) => job.status === "pending").length,
      activeJobs: jobs.filter((job) => job.status === "processing").length,
      isProcessing: jobs.some((job) => job.status === "processing"),
    };
  }

  async clearQueue(): Promise<{
    pendingCleared: number;
    processingReset: number;
  }> {
    let pendingCleared = 0;
    let processingReset = 0;
    for (const job of this.jobs()) {
      if (job.status === "pending") {
        demoRepository.deleteResource(RESOURCE_KIND, job.id);
        pendingCleared += 1;
      } else if (job.status === "processing") {
        demoRepository.putResource(RESOURCE_KIND, job.id, {
          ...job,
          status: "failed",
          error_message: "Demo queue cleared",
          completed_at: DEMO_TIMESTAMP,
        });
        processingReset += 1;
      }
    }
    return { pendingCleared, processingReset };
  }

  getDownload(id: number): { filename: string; content: Buffer } {
    const job = demoRepository.getResource(
      RESOURCE_KIND,
      id
    ) as DemoConversionJob | null;
    if (!job || job.status !== "completed") {
      throw new NotFoundError("Conversion not completed");
    }
    return {
      filename: `demo-conversion-${id}.txt`,
      content: Buffer.from(`Demo conversion ${id}\n`, "utf8"),
    };
  }

  private jobs(): DemoConversionJob[] {
    return demoRepository.listResources(RESOURCE_KIND) as DemoConversionJob[];
  }

  private nextId(): number {
    const jobs = this.jobs();
    return jobs.length === 0 ? 1 : Math.max(...jobs.map((job) => job.id)) + 1;
  }
}

export const conversionOperationsDemoService =
  new ConversionOperationsDemoService();
