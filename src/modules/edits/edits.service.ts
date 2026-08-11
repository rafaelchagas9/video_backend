import { constants, existsSync } from "fs";
import { access, realpath, stat } from "fs/promises";
import { dirname, isAbsolute, relative, resolve } from "path";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/config/drizzle";
import { editJobsTable, videosTable } from "@/database/schema";
import { directoriesService } from "@/modules/directories/directories.service";
import { videosService } from "@/modules/videos/videos.service";
import { ConflictError, NotFoundError, ValidationError } from "@/utils/errors";
import { logger } from "@/utils/logger";
import { editsQueue } from "./edits.queue";
import { editsDemoService } from "./edits.demo.service";
import { env } from "@/config/env";
import { canonicalizeOutputFileName } from "./edits.output";
import { validateEditRequest } from "./edits.validation";
import type {
  CreateEditJobInput,
  EditJob,
  EditJobListOptions,
  EditJobListResult,
  EditJobStatus,
  EditOutputConfig,
  EditQueuePayload,
  EditTimelineConfig,
} from "./edits.types";

const ACTIVE_STATUSES: EditJobStatus[] = ["pending", "queued", "running"];
const TERMINAL_STATUSES: EditJobStatus[] = ["completed", "failed", "cancelled"];
export { canonicalizeOutputFileName } from "./edits.output";
export {
  calculateExpectedDuration,
  validateEditRequest,
} from "./edits.validation";

export interface SafeEditOutputTarget {
  directoryPath: string;
  fileName: string;
  finalPath: string;
  tempDirectoryPath: string;
}

export async function resolveSafeOutputTarget(
  output: EditOutputConfig
): Promise<SafeEditOutputTarget> {
  const directory = await directoriesService.findById(output.directory_id);
  if (!directory.is_active) {
    throw new ValidationError("Output directory is not active");
  }

  const directoryPath = await realpath(directory.path);
  const directoryStats = await stat(directoryPath);
  if (!directoryStats.isDirectory()) {
    throw new ValidationError("Output path is not a directory");
  }
  await access(directoryPath, constants.W_OK);

  const fileName = canonicalizeOutputFileName(output.file_name);
  const finalPath = resolve(directoryPath, fileName);
  const childPath = relative(directoryPath, finalPath);
  if (
    !childPath ||
    childPath.startsWith("..") ||
    isAbsolute(childPath) ||
    dirname(finalPath) !== directoryPath
  ) {
    throw new ValidationError("Output file must be contained in its directory");
  }
  if (existsSync(finalPath)) {
    throw new ConflictError(`Output file already exists: ${fileName}`);
  }

  return {
    directoryPath,
    fileName,
    finalPath,
    tempDirectoryPath: resolve(directoryPath, ".temp_edits"),
  };
}

export class EditsService {
  async create(videoId: number, input: CreateEditJobInput): Promise<EditJob> {
    if (env.DEMO_MODE) return editsDemoService.create(videoId, input);

    const sourceVideo = await videosService.findById(videoId);
    const canonicalInput: CreateEditJobInput = {
      output: {
        ...input.output,
        file_name: canonicalizeOutputFileName(input.output.file_name),
      },
      timeline: input.timeline,
    };
    validateEditRequest(canonicalInput, sourceVideo.duration_seconds);
    const target = await resolveSafeOutputTarget(canonicalInput.output);

    const [catalogConflict] = await db
      .select({ id: videosTable.id })
      .from(videosTable)
      .where(eq(videosTable.filePath, target.finalPath))
      .limit(1);
    if (catalogConflict) {
      throw new ConflictError("Output path is already registered as a video");
    }

    const activeJobs = await db
      .select({ outputConfig: editJobsTable.outputConfig })
      .from(editJobsTable)
      .where(inArray(editJobsTable.status, ACTIVE_STATUSES));
    const alreadyReserved = activeJobs.some((row) => {
      try {
        const config = row.outputConfig as EditOutputConfig;
        return (
          config.directory_id === canonicalInput.output.directory_id &&
          canonicalizeOutputFileName(config.file_name) ===
            canonicalInput.output.file_name
        );
      } catch {
        return false;
      }
    });
    if (alreadyReserved) {
      throw new ConflictError(
        "An active edit job already uses this output file"
      );
    }

    const [job] = await db
      .insert(editJobsTable)
      .values({
        videoId,
        status: "queued",
        outputConfig: canonicalInput.output,
        timelineConfig: canonicalInput.timeline,
        progress: 0,
      })
      .returning();
    if (!job) throw new Error("Failed to create edit job");

    try {
      await editsQueue.enqueue({
        jobId: job.id,
        videoId,
        outputConfig: canonicalInput.output,
        timelineConfig: canonicalInput.timeline,
      });
    } catch (error) {
      logger.error({ error, jobId: job.id }, "Failed to enqueue edit job");
      await this.markFailed(job.id, "Failed to queue video rendering");
      throw error;
    }

    return this.mapToDto(job);
  }

  async getById(id: number): Promise<EditJob> {
    if (env.DEMO_MODE) return editsDemoService.getById(id);
    const job = await db.query.editJobsTable.findFirst({
      where: (jobs, { eq }) => eq(jobs.id, id),
    });
    if (!job) throw new NotFoundError(`Edit job not found with id: ${id}`);
    return this.mapToDto(job);
  }

  async list(options: EditJobListOptions): Promise<EditJobListResult> {
    if (env.DEMO_MODE) {
      return editsDemoService.list(options);
    }

    const conditions = [];
    if (options.videoId !== undefined) {
      conditions.push(eq(editJobsTable.videoId, options.videoId));
    }
    if (options.status !== undefined) {
      conditions.push(eq(editJobsTable.status, options.status));
    }
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
    const offset = (options.page - 1) * options.limit;

    const [countRow, rows] = await Promise.all([
      db
        .select({ total: sql<number>`count(*)::int` })
        .from(editJobsTable)
        .where(whereClause)
        .then((result) => result[0]),
      db
        .select()
        .from(editJobsTable)
        .where(whereClause)
        .orderBy(desc(editJobsTable.createdAt), desc(editJobsTable.id))
        .limit(options.limit)
        .offset(offset),
    ]);
    const total = countRow?.total ?? 0;
    return {
      data: rows.map((row) => this.mapToDto(row)),
      pagination: {
        page: options.page,
        limit: options.limit,
        total,
        totalPages: Math.ceil(total / options.limit),
      },
    };
  }

  async claimForProcessing(id: number): Promise<boolean> {
    const [claimed] = await db
      .update(editJobsTable)
      .set({
        status: "running",
        startedAt: new Date(),
        completedAt: null,
        errorMessage: null,
      })
      .where(and(eq(editJobsTable.id, id), eq(editJobsTable.status, "queued")))
      .returning({ id: editJobsTable.id });
    return Boolean(claimed);
  }

  async updateProgress(id: number, progress: number): Promise<boolean> {
    const [updated] = await db
      .update(editJobsTable)
      .set({ progress: Math.max(0, Math.min(99, Math.round(progress))) })
      .where(and(eq(editJobsTable.id, id), eq(editJobsTable.status, "running")))
      .returning({ id: editJobsTable.id });
    return Boolean(updated);
  }

  async markCompleted(
    id: number,
    outputPath: string,
    outputVideoId: number
  ): Promise<boolean> {
    const [updated] = await db
      .update(editJobsTable)
      .set({
        status: "completed",
        outputPath,
        outputVideoId,
        progress: 100,
        completedAt: new Date(),
        errorMessage: null,
      })
      .where(and(eq(editJobsTable.id, id), eq(editJobsTable.status, "running")))
      .returning({ id: editJobsTable.id });
    return Boolean(updated);
  }

  async markFailed(id: number, errorMessage: string): Promise<boolean> {
    const [updated] = await db
      .update(editJobsTable)
      .set({
        status: "failed",
        errorMessage,
        completedAt: new Date(),
      })
      .where(
        and(
          eq(editJobsTable.id, id),
          inArray(editJobsTable.status, ACTIVE_STATUSES)
        )
      )
      .returning({ id: editJobsTable.id });
    return Boolean(updated);
  }

  /** Compatibility entry point for callers that do not need a transition result. */
  async updateStatus(
    id: number,
    status: EditJobStatus,
    updates: Partial<Omit<EditJob, "id" | "videoId" | "status">> = {}
  ): Promise<void> {
    const updateData: Partial<typeof editJobsTable.$inferInsert> = {
      status,
      progress: updates.progress,
      outputConfig: updates.outputConfig,
      timelineConfig: updates.timelineConfig,
      outputPath: updates.outputPath,
      outputVideoId: updates.outputVideoId,
      errorMessage: updates.errorMessage,
      startedAt: updates.startedAt ? new Date(updates.startedAt) : undefined,
      completedAt: updates.completedAt
        ? new Date(updates.completedAt)
        : undefined,
    };
    if (status === "running" && !updates.startedAt) {
      updateData.startedAt = new Date();
    }
    if (TERMINAL_STATUSES.includes(status) && !updates.completedAt) {
      updateData.completedAt = new Date();
    }
    await db
      .update(editJobsTable)
      .set(updateData)
      .where(
        and(
          eq(editJobsTable.id, id),
          inArray(editJobsTable.status, ACTIVE_STATUSES)
        )
      );
  }

  async cancel(id: number): Promise<EditJob> {
    if (env.DEMO_MODE) return editsDemoService.cancel(id);

    const job = await this.getById(id);
    if (TERMINAL_STATUSES.includes(job.status)) return job;

    const [cancelled] = await db
      .update(editJobsTable)
      .set({ status: "cancelled", completedAt: new Date() })
      .where(
        and(
          eq(editJobsTable.id, id),
          inArray(editJobsTable.status, ACTIVE_STATUSES)
        )
      )
      .returning({ id: editJobsTable.id });

    if (cancelled) {
      try {
        await editsQueue.cancel(id);
      } catch (error) {
        // The guarded DB status remains authoritative. Any stale payload will be
        // skipped by claimForProcessing even if Redis cleanup is unavailable.
        logger.warn(
          { error, jobId: id },
          "Edit job cancelled but queue cleanup was unavailable"
        );
      }
    }
    return this.getById(id);
  }

  /** Reset interrupted running rows and provide the durable queue source. */
  async recoverableQueuePayloads(): Promise<EditQueuePayload[]> {
    await db
      .update(editJobsTable)
      .set({ status: "queued", startedAt: null })
      .where(eq(editJobsTable.status, "running"));

    const rows = await db
      .select({
        id: editJobsTable.id,
        videoId: editJobsTable.videoId,
        outputConfig: editJobsTable.outputConfig,
        timelineConfig: editJobsTable.timelineConfig,
      })
      .from(editJobsTable)
      .where(eq(editJobsTable.status, "queued"))
      .orderBy(editJobsTable.createdAt);

    return rows.map((row) => ({
      jobId: row.id,
      videoId: row.videoId,
      outputConfig: row.outputConfig as EditOutputConfig,
      timelineConfig: row.timelineConfig as EditTimelineConfig,
    }));
  }

  private mapToDto(row: typeof editJobsTable.$inferSelect): EditJob {
    return {
      id: row.id,
      videoId: row.videoId,
      status: row.status as EditJobStatus,
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
