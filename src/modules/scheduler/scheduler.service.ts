import cron, { type ScheduledTask } from "node-cron";
import { db } from "@/config/drizzle";
import { watchedDirectoriesTable } from "@/database/schema";
import { eq, and } from "drizzle-orm";
import { watcherService } from "@/modules/directories/watcher.service";
import { storageStatsService } from "@/modules/stats/stats.storage.service";
import { libraryStatsService } from "@/modules/stats/stats.library.service";
import { contentStatsService } from "@/modules/stats/stats.content.service";
import { usageStatsService } from "@/modules/stats/stats.usage.service";
import { statsCleanupService } from "@/modules/stats/stats.cleanup.service";
import { logger } from "@/utils/logger";

interface ScheduledTaskInfo {
  directoryId: number;
  cronJob: ScheduledTask;
  intervalMinutes: number;
}

interface SystemTask {
  name: string;
  cronJob: ScheduledTask;
  cronExpression: string;
}

export class SchedulerService {
  private tasks: Map<number, ScheduledTaskInfo> = new Map();
  private systemTasks: Map<string, SystemTask> = new Map();
  private isRunning = false;

  /**
   * Start the scheduler - sets up cron jobs for all active directories and system tasks
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn("Scheduler is already running");
      return;
    }

    logger.info("Starting scheduler");

    // Get all active directories with auto_scan enabled
    const directories = await db
      .select({
        id: watchedDirectoriesTable.id,
        path: watchedDirectoriesTable.path,
        scan_interval_minutes: watchedDirectoriesTable.scanIntervalMinutes,
      })
      .from(watchedDirectoriesTable)
      .where(
        and(
          eq(watchedDirectoriesTable.isActive, true),
          eq(watchedDirectoriesTable.autoScan, true),
        ),
      );

    for (const dir of directories) {
      this.scheduleDirectory(dir.id, dir.scan_interval_minutes, dir.path);
    }

    // Schedule stats snapshot jobs
    this.scheduleStatsJobs();

    this.isRunning = true;
    logger.info(
      {
        scheduledDirectories: directories.length,
        systemTasks: this.systemTasks.size,
      },
      "Scheduler started",
    );
  }

  /**
   * Stop the scheduler - cancels all cron jobs
   */
  stop(): void {
    if (!this.isRunning) {
      logger.warn("Scheduler is not running");
      return;
    }

    logger.info("Stopping scheduler");

    for (const [directoryId, task] of this.tasks) {
      task.cronJob.stop();
      logger.debug({ directoryId }, "Stopped scheduled scan");
    }

    for (const [name, task] of this.systemTasks) {
      task.cronJob.stop();
      logger.debug({ name }, "Stopped system task");
    }

    this.tasks.clear();
    this.systemTasks.clear();
    this.isRunning = false;
    logger.info("Scheduler stopped");
  }

  /**
   * Schedule a directory for periodic scanning
   */
  scheduleDirectory(
    directoryId: number,
    intervalMinutes: number,
    path?: string,
  ): void {
    // Remove existing schedule if any
    this.unscheduleDirectory(directoryId);

    // Convert minutes to cron expression
    const cronExpression = this.minutesToCron(intervalMinutes);

    const cronJob = cron.schedule(cronExpression, async () => {
      logger.info(
        { directoryId, path, intervalMinutes, triggeredBy: "scheduler" },
        `Running scheduled scan (interval: ${intervalMinutes}min)`,
      );
      try {
        const result = await watcherService.scanDirectory(directoryId);
        logger.info({ directoryId, path, result }, "Scheduled scan completed");
      } catch (error) {
        logger.error({ directoryId, path, error }, "Scheduled scan failed");
      }
    });

    this.tasks.set(directoryId, {
      directoryId,
      cronJob,
      intervalMinutes,
    });

    logger.info(
      { directoryId, path, intervalMinutes, cronExpression },
      "Directory scheduled for scanning",
    );
  }

  /**
   * Remove a directory from the scan schedule
   */
  unscheduleDirectory(directoryId: number): void {
    const task = this.tasks.get(directoryId);
    if (task) {
      task.cronJob.stop();
      this.tasks.delete(directoryId);
      logger.debug({ directoryId }, "Directory unscheduled");
    }
  }

  /**
   * Update a directory's scan schedule
   */
  updateSchedule(
    directoryId: number,
    intervalMinutes: number,
    path?: string,
  ): void {
    if (this.tasks.has(directoryId)) {
      this.scheduleDirectory(directoryId, intervalMinutes, path);
    }
  }

  /**
   * Get the current scheduler status
   */
  getStatus(): {
    isRunning: boolean;
    scheduledDirectories: number;
    schedules: Array<{ directoryId: number; intervalMinutes: number }>;
    systemTasks: Array<{ name: string; cronExpression: string }>;
  } {
    return {
      isRunning: this.isRunning,
      scheduledDirectories: this.tasks.size,
      schedules: Array.from(this.tasks.values()).map((task) => ({
        directoryId: task.directoryId,
        intervalMinutes: task.intervalMinutes,
      })),
      systemTasks: Array.from(this.systemTasks.values()).map((task) => ({
        name: task.name,
        cronExpression: task.cronExpression,
      })),
    };
  }

  /**
   * Schedule stats snapshot jobs
   */
  private scheduleStatsJobs(): void {
    // Storage stats - hourly (at minute 0)
    const storageJob = cron.schedule("0 * * * *", async () => {
      logger.info({ job: "storage-stats" }, "Running hourly storage snapshot");
      try {
        await storageStatsService.createStorageSnapshot();
        logger.info({ job: "storage-stats" }, "Storage snapshot completed");
      } catch (error) {
        logger.error(
          { job: "storage-stats", error },
          "Storage snapshot failed",
        );
      }
    });

    this.systemTasks.set("storage-stats", {
      name: "storage-stats",
      cronJob: storageJob,
      cronExpression: "0 * * * *",
    });

    // Library, Content, Usage stats - daily at midnight
    const dailyStatsJob = cron.schedule("0 0 * * *", async () => {
      logger.info({ job: "daily-stats" }, "Running daily stats snapshots");
      try {
        await libraryStatsService.createLibrarySnapshot();
        await contentStatsService.createContentSnapshot();
        await usageStatsService.createUsageSnapshot();
        logger.info({ job: "daily-stats" }, "Daily stats snapshots completed");
      } catch (error) {
        logger.error(
          { job: "daily-stats", error },
          "Daily stats snapshots failed",
        );
      }
    });

    this.systemTasks.set("daily-stats", {
      name: "daily-stats",
      cronJob: dailyStatsJob,
      cronExpression: "0 0 * * *",
    });

    // Cleanup old snapshots - weekly on Sunday at 3 AM
    const cleanupJob = cron.schedule("0 3 * * 0", async () => {
      logger.info({ job: "stats-cleanup" }, "Running stats cleanup");
      try {
        const result = await statsCleanupService.cleanupOldSnapshots();
        logger.info(
          { job: "stats-cleanup", result },
          "Stats cleanup completed",
        );
      } catch (error) {
        logger.error({ job: "stats-cleanup", error }, "Stats cleanup failed");
      }
    });

    this.systemTasks.set("stats-cleanup", {
      name: "stats-cleanup",
      cronJob: cleanupJob,
      cronExpression: "0 3 * * 0",
    });

    logger.info(
      {
        jobs: [
          "storage-stats (hourly)",
          "daily-stats (midnight)",
          "stats-cleanup (weekly)",
        ],
      },
      "Stats jobs scheduled",
    );
  }

  /**
   * Convert minutes interval to cron expression
   */
  private minutesToCron(minutes: number): string {
    if (minutes < 1) {
      minutes = 1;
    }

    if (minutes < 60) {
      // Run every N minutes
      return `*/${minutes} * * * *`;
    } else if (minutes < 1440) {
      // Convert to hours
      const hours = Math.floor(minutes / 60);
      return `0 */${hours} * * *`;
    } else {
      // Daily at midnight
      return "0 0 * * *";
    }
  }
}

export const schedulerService = new SchedulerService();
