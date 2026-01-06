import cron from "node-cron";
import { getDatabase } from "@/config/database";
import { watcherService } from "@/modules/directories/watcher.service";
import { logger } from "@/utils/logger";
import type { Directory } from "@/modules/directories/directories.types";

interface ScheduledTask {
  directoryId: number;
  cronJob: cron.ScheduledTask;
  intervalMinutes: number;
}

export class SchedulerService {
  private tasks: Map<number, ScheduledTask> = new Map();
  private isRunning = false;

  private get db() {
    return getDatabase();
  }

  /**
   * Start the scheduler - sets up cron jobs for all active directories
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn("Scheduler is already running");
      return;
    }

    logger.info("Starting directory scan scheduler");

    // Get all active directories with auto_scan enabled
    const directories = this.db
      .prepare(
        `SELECT id, path, scan_interval_minutes 
         FROM watched_directories 
         WHERE is_active = 1 AND auto_scan = 1`
      )
      .all() as Pick<Directory, "id" | "path" | "scan_interval_minutes">[];

    for (const dir of directories) {
      this.scheduleDirectory(dir.id, dir.scan_interval_minutes, dir.path);
    }

    this.isRunning = true;
    logger.info(
      { scheduledDirectories: directories.length },
      "Scheduler started"
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

    logger.info("Stopping directory scan scheduler");

    for (const [directoryId, task] of this.tasks) {
      task.cronJob.stop();
      logger.debug({ directoryId }, "Stopped scheduled scan");
    }

    this.tasks.clear();
    this.isRunning = false;
    logger.info("Scheduler stopped");
  }

  /**
   * Schedule a directory for periodic scanning
   */
  scheduleDirectory(
    directoryId: number,
    intervalMinutes: number,
    path?: string
  ): void {
    // Remove existing schedule if any
    this.unscheduleDirectory(directoryId);

    // Convert minutes to cron expression
    const cronExpression = this.minutesToCron(intervalMinutes);

    const cronJob = cron.schedule(cronExpression, async () => {
      logger.info({ directoryId, path }, "Running scheduled scan");
      try {
        const result = await watcherService.scanDirectory(directoryId);
        logger.info(
          { directoryId, path, result },
          "Scheduled scan completed"
        );
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
      "Directory scheduled for scanning"
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
    path?: string
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
  } {
    return {
      isRunning: this.isRunning,
      scheduledDirectories: this.tasks.size,
      schedules: Array.from(this.tasks.values()).map((task) => ({
        directoryId: task.directoryId,
        intervalMinutes: task.intervalMinutes,
      })),
    };
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
