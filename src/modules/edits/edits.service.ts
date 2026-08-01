import { eq } from "drizzle-orm";
import { db } from "@/config/drizzle";
import { editJobsTable } from "@/database/schema";
import { NotFoundError, ValidationError } from "@/utils/errors";
import { editsQueue } from "./edits.queue";
import { editsDemoService } from "./edits.demo.service";
import { env } from "@/config/env";
import type {
  EditJob,
  CreateEditJobInput,
  EditOutputConfig,
  EditTimelineConfig,
} from "./edits.types";

export class EditsService {
  /**
   * Create a new edit job
   */
  async create(videoId: number, input: CreateEditJobInput): Promise<EditJob> {
    if (env.DEMO_MODE) return editsDemoService.create(videoId, input);

    // Basic validation
    if (input.timeline.segments.length === 0) {
      throw new ValidationError("Timeline must have at least one segment");
    }

    // Insert into DB
    const [job] = await db
      .insert(editJobsTable)
      .values({
        videoId,
        status: "queued",
        outputConfig: input.output,
        timelineConfig: input.timeline,
        progress: 0,
      })
      .returning();

    // Enqueue in Redis
    await editsQueue.enqueue({
      jobId: job.id,
      videoId,
      outputConfig: input.output as EditOutputConfig,
      timelineConfig: input.timeline as EditTimelineConfig,
    });

    return this.mapToDto(job);
  }

  /**
   * Get job by ID
   */
  async getById(id: number): Promise<EditJob> {
    if (env.DEMO_MODE) return editsDemoService.getById(id);

    const job = await db.query.editJobsTable.findFirst({
      where: (jobs, { eq }) => eq(jobs.id, id),
    });

    if (!job) {
      throw new NotFoundError(`Edit job not found with id: ${id}`);
    }

    return this.mapToDto(job);
  }

  /**
   * Update job status
   */
  async updateStatus(
    id: number,
    status: EditJob["status"],
    updates: Partial<Omit<EditJob, "id" | "videoId" | "status">> = {}
  ): Promise<void> {
    const updateData: any = { status, ...updates };

    if (status === "running" && !updates.startedAt) {
      updateData.startedAt = new Date();
    }
    if (
      (status === "completed" || status === "failed") &&
      !updates.completedAt
    ) {
      updateData.completedAt = new Date();
    }

    await db
      .update(editJobsTable)
      .set(updateData)
      .where(eq(editJobsTable.id, id));
  }

  /**
   * Cancel a job
   */
  async cancel(id: number): Promise<EditJob> {
    if (env.DEMO_MODE) return editsDemoService.cancel(id);

    const job = await this.getById(id);

    if (
      job.status === "completed" ||
      job.status === "failed" ||
      job.status === "cancelled"
    ) {
      return job;
    }

    // Update DB
    await this.updateStatus(id, "cancelled");

    // Note: If it's running in the processor, the processor needs to check this status
    // or handle a kill signal. For now, we just mark DB.
    // The processor polling or signal handling will be implemented in the processor service.

    return this.getById(id);
  }

  private mapToDto(row: typeof editJobsTable.$inferSelect): EditJob {
    return {
      id: row.id,
      videoId: row.videoId,
      status: row.status as EditJob["status"],
      progress: row.progress,
      outputConfig: row.outputConfig as EditOutputConfig,
      timelineConfig: row.timelineConfig as EditTimelineConfig,
      outputPath: row.outputPath,
      outputVideoId: row.outputVideoId,
      errorMessage: row.errorMessage,
      startedAt: row.startedAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }
}

export const editsService = new EditsService();
