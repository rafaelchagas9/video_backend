/**
 * Conversion jobs service
 * Handles CRUD operations for conversion jobs using Drizzle ORM
 */
import { sql, eq, and, inArray } from "drizzle-orm";
import { db } from "@/config/drizzle";
import { conversionJobsTable } from "@/database/schema";
import { NotFoundError, BadRequestError } from "@/utils/errors";
import { logger } from "@/utils/logger";
import type { ConversionJob } from "./conversion.types";

export class ConversionJobsService {
  /**
   * Create a conversion job
   */
  async create(data: {
    videoId: number;
    preset: string;
    targetResolution: string;
    codec: string;
    outputPath: string;
    deleteOriginal: boolean;
    batchId?: string;
  }): Promise<ConversionJob> {
    const result = await db
      .insert(conversionJobsTable)
      .values({
        videoId: data.videoId,
        status: "pending",
        preset: data.preset,
        targetResolution: data.targetResolution,
        codec: data.codec,
        outputPath: data.outputPath,
        deleteOriginal: data.deleteOriginal,
        batchId: data.batchId || null,
        progressPercent: 0,
      })
      .returning();

    if (!result || result.length === 0) {
      throw new Error("Failed to create conversion job");
    }

    return this.mapToApiFormat(result[0]);
  }

  /**
   * Find job by ID
   */
  async findById(id: number): Promise<ConversionJob> {
    const result = await db
      .select()
      .from(conversionJobsTable)
      .where(eq(conversionJobsTable.id, id));

    if (!result || result.length === 0) {
      throw new NotFoundError(`Conversion job not found: ${id}`);
    }

    return this.mapToApiFormat(result[0]);
  }

  /**
   * List jobs for a video
   */
  async listByVideoId(videoId: number): Promise<ConversionJob[]> {
    const result = await db
      .select()
      .from(conversionJobsTable)
      .where(eq(conversionJobsTable.videoId, videoId))
      .orderBy(sql`created_at DESC`);

    return result.map((row) => this.mapToApiFormat(row));
  }

  /**
   * Check if job exists with video and preset in pending/processing state
   */
  async findExisting(
    videoId: number,
    preset: string,
  ): Promise<ConversionJob | null> {
    const result = await db
      .select()
      .from(conversionJobsTable)
      .where(
        and(
          eq(conversionJobsTable.videoId, videoId),
          eq(conversionJobsTable.preset, preset),
          inArray(conversionJobsTable.status, ["pending", "processing"]),
        ),
      );

    if (!result || result.length === 0) {
      return null;
    }

    return this.mapToApiFormat(result[0]);
  }

  /**
   * Update job status to processing
   */
  async markAsProcessing(id: number): Promise<void> {
    await db
      .update(conversionJobsTable)
      .set({
        status: "processing",
        startedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(conversionJobsTable.id, id));
  }

  /**
   * Update job progress
   */
  async updateProgress(id: number, progress: number): Promise<void> {
    await db
      .update(conversionJobsTable)
      .set({
        progressPercent: progress,
      })
      .where(eq(conversionJobsTable.id, id));
  }

  /**
   * Mark job as completed
   */
  async markAsCompleted(id: number, outputSizeBytes: number): Promise<void> {
    await db
      .update(conversionJobsTable)
      .set({
        status: "completed",
        progressPercent: 100,
        outputSizeBytes,
        completedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(conversionJobsTable.id, id));
  }

  /**
   * Mark job as failed
   */
  async markAsFailed(id: number, errorMessage: string): Promise<void> {
    await db
      .update(conversionJobsTable)
      .set({
        status: "failed",
        errorMessage,
        completedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(conversionJobsTable.id, id));
  }

  /**
   * Cancel a pending job
   */
  async cancel(id: number): Promise<ConversionJob> {
    const job = await this.findById(id);

    if (job.status !== "pending") {
      throw new BadRequestError(`Cannot cancel job in ${job.status} status`);
    }

    await db
      .update(conversionJobsTable)
      .set({
        status: "cancelled",
        completedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(conversionJobsTable.id, id));

    return this.findById(id);
  }

  /**
   * Delete a job (only completed/failed/cancelled)
   */
  async delete(id: number): Promise<void> {
    const job = await this.findById(id);

    if (job.status === "pending" || job.status === "processing") {
      throw new BadRequestError(`Cannot delete job in ${job.status} status`);
    }

    await db.delete(conversionJobsTable).where(eq(conversionJobsTable.id, id));

    logger.info({ jobId: id }, "Conversion job deleted");
  }

  /**
   * Get active conversions (pending and processing) with video info
   */
  async getActiveConversions(): Promise<
    {
      id: number;
      video_id: number;
      video_title: string;
      preset: string;
      status: "pending" | "processing";
      progress_percent: number;
      started_at: string | null;
      created_at: string;
    }[]
  > {
    const query = sql`
      SELECT
        cj.id,
        cj.video_id,
        COALESCE(v.title, v.file_name) as video_title,
        cj.preset,
        cj.status,
        cj.progress_percent,
        cj.started_at,
        cj.created_at
      FROM conversion_jobs cj
      LEFT JOIN videos v ON v.id = cj.video_id
      WHERE cj.status IN ('pending', 'processing')
      ORDER BY cj.created_at ASC
    `;

    const result = await db.execute(query);

    return result as any[];
  }

  /**
   * Get jobs by batch ID
   */
  async findByBatchId(batchId: string): Promise<ConversionJob[]> {
    const result = await db
      .select()
      .from(conversionJobsTable)
      .where(eq(conversionJobsTable.batchId, batchId));

    return result.map((row) => this.mapToApiFormat(row));
  }

  /**
   * Count pending/processing jobs in a batch
   */
  async countPendingInBatch(batchId: string): Promise<number> {
    const query = sql`
      SELECT COUNT(*) as count
      FROM conversion_jobs
      WHERE batch_id = ${batchId}
        AND status IN ('pending', 'processing')
    `;

    const result = await db.execute(query);
    return (result[0] as any)?.count ?? 0;
  }

  /**
   * Get batch statistics
   */
  async getBatchStats(batchId: string): Promise<{
    total: number;
    completed: number;
    failed: number;
  }> {
    const query = sql`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
      FROM conversion_jobs
      WHERE batch_id = ${batchId}
    `;

    const result = await db.execute(query);
    const stats = result[0] as any;

    return {
      total: stats?.total ?? 0,
      completed: stats?.completed ?? 0,
      failed: stats?.failed ?? 0,
    };
  }

  /**
   * Get all output paths for a batch
   */
  async getBatchOutputPaths(batchId: string): Promise<string[]> {
    const result = await db
      .select({ outputPath: conversionJobsTable.outputPath })
      .from(conversionJobsTable)
      .where(eq(conversionJobsTable.batchId, batchId));

    return result
      .map((row) => row.outputPath)
      .filter((path): path is string => path !== null);
  }

  /**
   * Clear all pending jobs (mark as cancelled)
   */
  async clearPending(): Promise<number> {
    // Get pending jobs for count
    const pendingJobs = await db
      .select({ id: conversionJobsTable.id })
      .from(conversionJobsTable)
      .where(eq(conversionJobsTable.status, "pending"));

    // Update to cancelled
    await db
      .update(conversionJobsTable)
      .set({
        status: "cancelled",
        completedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(conversionJobsTable.status, "pending"));

    return pendingJobs.length;
  }

  /**
   * Clear all processing jobs (mark as failed - stuck jobs)
   */
  async clearProcessing(): Promise<number> {
    // Get processing jobs for count
    const processingJobs = await db
      .select({ id: conversionJobsTable.id })
      .from(conversionJobsTable)
      .where(eq(conversionJobsTable.status, "processing"));

    // Update to failed
    await db
      .update(conversionJobsTable)
      .set({
        status: "failed",
        errorMessage: "Manually cleared by user",
        completedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(conversionJobsTable.status, "processing"));

    return processingJobs.length;
  }

  /**
   * Get jobs in pending or processing state for notifications
   */
  async getPendingJobsForNotification(): Promise<
    { id: number; video_id: number; preset: string }[]
  > {
    const result = await db
      .select({
        id: conversionJobsTable.id,
        video_id: conversionJobsTable.videoId,
        preset: conversionJobsTable.preset,
      })
      .from(conversionJobsTable)
      .where(eq(conversionJobsTable.status, "pending"));

    return result.map((row) => ({
      id: row.id,
      video_id: row.video_id,
      preset: row.preset,
    }));
  }

  /**
   * Get jobs in processing state for notifications
   */
  async getProcessingJobsForNotification(): Promise<
    { id: number; video_id: number; preset: string }[]
  > {
    const result = await db
      .select({
        id: conversionJobsTable.id,
        video_id: conversionJobsTable.videoId,
        preset: conversionJobsTable.preset,
      })
      .from(conversionJobsTable)
      .where(eq(conversionJobsTable.status, "processing"));

    return result.map((row) => ({
      id: row.id,
      video_id: row.video_id,
      preset: row.preset,
    }));
  }

  /**
   * Get jobs by video IDs (for queue view)
   */
  async findByVideoIds(videoIds: number[]): Promise<
    {
      video_id: number;
      job_id: number;
      job_status: string;
      progress_percent: number;
    }[]
  > {
    if (videoIds.length === 0) {
      return [];
    }

    const result = await db
      .select({
        video_id: conversionJobsTable.videoId,
        job_id: conversionJobsTable.id,
        job_status: conversionJobsTable.status,
        progress_percent: conversionJobsTable.progressPercent,
      })
      .from(conversionJobsTable)
      .where(
        and(
          inArray(conversionJobsTable.videoId, videoIds),
          inArray(conversionJobsTable.status, ["pending", "processing"]),
        ),
      )
      .orderBy(sql`created_at ASC`);

    return result.map((row) => ({
      video_id: row.video_id,
      job_id: row.job_id,
      job_status: row.job_status ?? "pending",
      progress_percent: row.progress_percent ?? 0,
    }));
  }

  /**
   * Map Drizzle result to API format
   */
  private mapToApiFormat(row: any): ConversionJob {
    return {
      id: row.id,
      video_id: row.video_id ?? row.videoId,
      status: row.status,
      preset: row.preset,
      target_resolution: row.target_resolution ?? row.targetResolution,
      codec: row.codec,
      output_path: row.output_path ?? row.outputPath,
      output_size_bytes: row.output_size_bytes ?? row.outputSizeBytes,
      progress_percent: row.progress_percent ?? row.progressPercent ?? 0,
      error_message: row.error_message ?? row.errorMessage,
      delete_original: row.delete_original ?? row.deleteOriginal ?? false,
      batch_id: row.batch_id ?? row.batchId,
      started_at:
        row.started_at instanceof Date
          ? row.started_at.toISOString()
          : (row.started_at ?? row.startedAt?.toISOString() ?? null),
      completed_at:
        row.completed_at instanceof Date
          ? row.completed_at.toISOString()
          : (row.completed_at ?? row.completedAt?.toISOString() ?? null),
      created_at:
        row.created_at instanceof Date
          ? row.created_at.toISOString()
          : (row.created_at ?? row.createdAt.toISOString()),
    };
  }
}

export const conversionJobsService = new ConversionJobsService();
