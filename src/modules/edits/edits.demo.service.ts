import { demoRepository } from "@/database/demo";
import { NotFoundError, ValidationError } from "@/utils/errors";
import type { CreateEditJobInput, EditJob } from "./edits.types";

const RESOURCE_KIND = "edit-job";
const DEMO_TIMESTAMP = "2026-01-01T12:00:00.000Z";

/** SQLite-only editor job simulation; it never invokes FFmpeg or Redis. */
export class EditsDemoService {
  async editingMetadata(videoId: number) {
    const video = demoRepository.getVideoById(videoId);
    return {
      id: video.id,
      title: video.title,
      duration: video.duration_seconds,
      fps: video.fps,
      resolution: { width: video.width, height: video.height },
      bitrate: video.bitrate,
      audio: { channels: null, sample_rate: null },
      storyboard_vtt: video.storyboard
        ? `/api/videos/${videoId}/thumbnails.vtt`
        : null,
    };
  }

  async create(videoId: number, input: CreateEditJobInput): Promise<EditJob> {
    demoRepository.getVideoById(videoId);
    if (input.timeline.segments.length === 0) {
      throw new ValidationError("Timeline must have at least one segment");
    }
    const jobs = this.jobs();
    const id = jobs.length ? Math.max(...jobs.map((job) => job.id)) + 1 : 1;
    const job: EditJob = {
      id,
      videoId,
      status: "queued",
      progress: 0,
      outputConfig: input.output,
      timelineConfig: input.timeline,
      outputPath: `/demo-generated/edits/${input.output.file_name}`,
      outputVideoId: null,
      errorMessage: null,
      startedAt: null,
      completedAt: null,
      createdAt: DEMO_TIMESTAMP,
    };
    demoRepository.putResource(RESOURCE_KIND, id, job);
    return job;
  }

  async getById(id: number): Promise<EditJob> {
    const job = demoRepository.getResource(RESOURCE_KIND, id) as EditJob | null;
    if (!job) throw new NotFoundError(`Edit job not found with id: ${id}`);
    return job;
  }

  async cancel(id: number): Promise<EditJob> {
    const job = await this.getById(id);
    if (["completed", "failed", "cancelled"].includes(job.status)) return job;
    const cancelled: EditJob = {
      ...job,
      status: "cancelled",
      completedAt: DEMO_TIMESTAMP,
    };
    demoRepository.putResource(RESOURCE_KIND, id, cancelled);
    return cancelled;
  }

  private jobs(): EditJob[] {
    return demoRepository.listResources(RESOURCE_KIND) as EditJob[];
  }
}

export const editsDemoService = new EditsDemoService();
