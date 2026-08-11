import { demoRepository } from "@/database/demo";
import { directoriesDemoService } from "@/modules/directories/directories.demo.service";
import { NotFoundError } from "@/utils/errors";
import { canonicalizeOutputFileName } from "./edits.output";
import { validateEditRequest } from "./edits.validation";
import type {
  CreateEditJobInput,
  EditJob,
  EditJobListOptions,
  EditJobListResult,
} from "./edits.types";

const RESOURCE_KIND = "edit-job";
const SIMULATION_RESOURCE_KIND = "edit-job-simulation";
const CREATED_TIMESTAMP = "2026-01-01T12:00:00.000Z";
const STARTED_TIMESTAMP = "2026-01-01T12:00:01.000Z";
const COMPLETED_TIMESTAMP = "2026-01-01T12:00:03.000Z";
const CANCELLED_TIMESTAMP = "2026-01-01T12:00:04.000Z";
const FAILURE_FILE_NAME_PREFIX = "demo-fail-";

interface DemoEditSimulation {
  outcome: "success" | "failure";
}

/** SQLite-only editor job simulation; it never invokes FFmpeg or Redis. */
export class EditsDemoService {
  async editingMetadata(videoId: number) {
    const video = demoRepository.getVideoById(videoId);
    const hasAudio = Boolean(video.audio_codec);
    return {
      id: video.id,
      title: video.title,
      duration: video.duration_seconds,
      fps: video.fps,
      resolution: { width: video.width, height: video.height },
      bitrate: video.bitrate,
      audio: {
        present: hasAudio,
        codec: video.audio_codec ?? null,
        channels: hasAudio ? 2 : null,
        sample_rate: hasAudio ? 48_000 : null,
      },
      storyboard_vtt: video.storyboard
        ? `/api/videos/${videoId}/thumbnails.vtt`
        : null,
    };
  }

  async create(videoId: number, input: CreateEditJobInput): Promise<EditJob> {
    const video = demoRepository.getVideoById(videoId);
    const canonicalInput: CreateEditJobInput = {
      output: {
        ...input.output,
        file_name: canonicalizeOutputFileName(input.output.file_name),
      },
      timeline: input.timeline,
    };
    validateEditRequest(canonicalInput, video.duration_seconds);
    directoriesDemoService.findById(canonicalInput.output.directory_id);
    const jobs = this.jobs();
    const id = jobs.length ? Math.max(...jobs.map((job) => job.id)) + 1 : 1;
    const job: EditJob = {
      id,
      videoId,
      status: "queued",
      progress: 0,
      outputConfig: canonicalInput.output,
      timelineConfig: canonicalInput.timeline,
      outputPath: null,
      outputVideoId: null,
      errorMessage: null,
      startedAt: null,
      completedAt: null,
      createdAt: CREATED_TIMESTAMP,
    };
    demoRepository.putResource(RESOURCE_KIND, id, job);
    const simulation: DemoEditSimulation = {
      outcome: canonicalInput.output.file_name
        .toLowerCase()
        .startsWith(FAILURE_FILE_NAME_PREFIX)
        ? "failure"
        : "success",
    };
    demoRepository.putResource(SIMULATION_RESOURCE_KIND, id, simulation);
    return job;
  }

  async getById(id: number): Promise<EditJob> {
    const job = this.readById(id);
    if (["completed", "failed", "cancelled"].includes(job.status)) {
      return job;
    }

    let advanced: EditJob;
    if (job.status === "queued" || job.status === "pending") {
      advanced = {
        ...job,
        status: "running",
        progress: 25,
        startedAt: STARTED_TIMESTAMP,
      };
    } else if (job.progress < 70) {
      advanced = { ...job, progress: 70 };
    } else {
      const simulation = demoRepository.getResource(
        SIMULATION_RESOURCE_KIND,
        id
      ) as DemoEditSimulation | null;
      if (simulation?.outcome === "failure") {
        advanced = {
          ...job,
          status: "failed",
          progress: 100,
          errorMessage:
            "Demo render failed as requested by the demo-fail- filename prefix",
          completedAt: COMPLETED_TIMESTAMP,
        };
      } else {
        const source = demoRepository.getVideoById(job.videoId);
        advanced = {
          ...job,
          status: "completed",
          progress: 100,
          outputPath: source.file_path,
          outputVideoId: source.id,
          completedAt: COMPLETED_TIMESTAMP,
        };
      }
    }

    demoRepository.putResource(RESOURCE_KIND, id, advanced);
    return advanced;
  }

  async list(
    options: Partial<EditJobListOptions> = {}
  ): Promise<EditJobListResult> {
    const page = Math.max(1, options.page ?? 1);
    const limit = Math.max(1, options.limit ?? 20);
    const matching = this.jobs()
      .filter(
        (job) =>
          options.videoId === undefined || job.videoId === options.videoId
      )
      .filter(
        (job) => options.status === undefined || job.status === options.status
      )
      .sort((left, right) => right.id - left.id);
    const total = matching.length;

    return {
      data: matching.slice((page - 1) * limit, page * limit),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  private readById(id: number): EditJob {
    const job = demoRepository.getResource(RESOURCE_KIND, id) as EditJob | null;
    if (!job) throw new NotFoundError(`Edit job not found with id: ${id}`);
    return job;
  }

  async cancel(id: number): Promise<EditJob> {
    const job = this.readById(id);
    if (["completed", "failed", "cancelled"].includes(job.status)) return job;
    const cancelled: EditJob = {
      ...job,
      status: "cancelled",
      completedAt: CANCELLED_TIMESTAMP,
    };
    demoRepository.putResource(RESOURCE_KIND, id, cancelled);
    return cancelled;
  }

  private jobs(): EditJob[] {
    return demoRepository.listResources(RESOURCE_KIND) as EditJob[];
  }
}

export const editsDemoService = new EditsDemoService();
