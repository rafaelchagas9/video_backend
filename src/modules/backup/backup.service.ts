import { existsSync, mkdirSync, unlinkSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";
import { db } from "@/config/drizzle";
import {
  usersTable,
  watchedDirectoriesTable,
  videosTable,
  creatorsTable,
  tagsTable,
  ratingsTable,
  playlistsTable,
  favoritesTable,
  bookmarksTable,
} from "@/database/schema";
import { env } from "@/config/env";
import { NotFoundError, ValidationError } from "@/utils/errors";
import { logger } from "@/utils/logger";
import type { BackupInfo, ExportData } from "./backup.types";

const BACKUP_DIR = resolve(process.cwd(), "./data/backups");

export class BackupService {
  /**
   * Ensure backup directory exists
   */
  private ensureBackupDir(): void {
    if (!existsSync(BACKUP_DIR)) {
      mkdirSync(BACKUP_DIR, { recursive: true });
    }
  }

  /**
   * Create a new database backup using pg_dump
   */
  async createBackup(): Promise<BackupInfo> {
    this.ensureBackupDir();

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `backup-${timestamp}.sql`;
    const backupPath = join(BACKUP_DIR, filename);

    try {
      const { execSync } = await import("child_process");

      // Build pg_dump command using POSTGRES_* env vars
      // Use PGPASSWORD to avoid exposing password in process list
      const pgDumpCommand = `PGPASSWORD='${env.POSTGRES_PASSWORD}' pg_dump -h ${env.POSTGRES_HOST} -p ${env.POSTGRES_PORT} -U ${env.POSTGRES_USER} -F p -d ${env.POSTGRES_DB} -f "${backupPath}"`;

      execSync(pgDumpCommand, { stdio: "pipe" });

      const stats = statSync(backupPath);

      logger.info(
        { filename, sizeBytes: stats.size },
        "Database backup created",
      );

      return {
        filename,
        path: backupPath,
        sizeBytes: stats.size,
        createdAt: new Date().toISOString(),
      };
    } catch (error) {
      logger.error({ error }, "Failed to create backup");
      throw new ValidationError(
        "Failed to create database backup. Ensure pg_dump is available.",
      );
    }
  }

  /**
   * List all available backups
   */
  listBackups(): BackupInfo[] {
    this.ensureBackupDir();

    const files = readdirSync(BACKUP_DIR).filter(
      (f) => f.endsWith(".sql") || f.endsWith(".db"),
    );

    return files
      .map((filename) => {
        const fullPath = join(BACKUP_DIR, filename);
        const stats = statSync(fullPath);

        return {
          filename,
          path: fullPath,
          sizeBytes: stats.size,
          createdAt: stats.mtime.toISOString(),
        };
      })
      .sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
  }

  /**
   * Restore from a backup file using psql
   */
  async restoreBackup(filename: string): Promise<void> {
    const backupPath = join(BACKUP_DIR, filename);

    if (!existsSync(backupPath)) {
      throw new NotFoundError(`Backup not found: ${filename}`);
    }

    try {
      const { execSync } = await import("child_process");

      // Build psql command using POSTGRES_* env vars
      // Use PGPASSWORD to avoid exposing password in process list
      const psqlCommand = `PGPASSWORD='${env.POSTGRES_PASSWORD}' psql -h ${env.POSTGRES_HOST} -p ${env.POSTGRES_PORT} -U ${env.POSTGRES_USER} -d ${env.POSTGRES_DB} -f "${backupPath}"`;

      execSync(psqlCommand, { stdio: "pipe" });

      logger.info({ filename }, "Database restored from backup");
    } catch (error) {
      logger.error({ error, filename }, "Failed to restore backup");
      throw new ValidationError(
        "Failed to restore database from backup. Ensure psql is available.",
      );
    }
  }

  /**
   * Delete a backup file
   */
  deleteBackup(filename: string): void {
    const backupPath = join(BACKUP_DIR, filename);

    if (!existsSync(backupPath)) {
      throw new NotFoundError(`Backup not found: ${filename}`);
    }

    unlinkSync(backupPath);
    logger.info({ filename }, "Backup deleted");
  }

  /**
   * Export entire database as JSON
   */
  async exportToJson(): Promise<ExportData> {
    // Use Drizzle to export data
    const [
      users,
      directories,
      videos,
      creators,
      tags,
      ratings,
      playlists,
      favorites,
      bookmarks,
    ] = await Promise.all([
      db
        .select({
          id: usersTable.id,
          username: usersTable.username,
          createdAt: usersTable.createdAt,
          updatedAt: usersTable.updatedAt,
        })
        .from(usersTable),
      db.select().from(watchedDirectoriesTable),
      db.select().from(videosTable),
      db.select().from(creatorsTable),
      db.select().from(tagsTable),
      db.select().from(ratingsTable),
      db.select().from(playlistsTable),
      db.select().from(favoritesTable),
      db.select().from(bookmarksTable),
    ]);

    logger.info("Database exported to JSON");

    return {
      exportedAt: new Date().toISOString(),
      version: "0.1.0",
      tables: {
        users,
        directories,
        videos,
        creators,
        tags,
        ratings,
        playlists,
        favorites,
        bookmarks,
      },
    };
  }
}

export const backupService = new BackupService();
