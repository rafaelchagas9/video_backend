import {
  mkdirSync,
  unlinkSync,
  readdirSync,
  statSync,
  lstatSync,
  renameSync,
  rmSync,
} from "fs";
import { basename, join, resolve } from "path";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
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
  creatorFavoritesTable,
  bookmarksTable,
} from "@/database/schema";
import { env } from "@/config/env";
import { NotFoundError, ValidationError } from "@/utils/errors";
import { logger } from "@/utils/logger";
import type { BackupInfo, ExportData } from "./backup.types";
import { backupDemoService } from "./backup.demo.service";

const BACKUP_DIR = resolve(process.cwd(), "./data/backups");
const execFileAsync = promisify(execFile);

export class BackupService {
  constructor(private readonly backupDirectory = BACKUP_DIR) {}

  private existingBackupPath(filename: string): string {
    if (
      !filename ||
      filename === "." ||
      filename === ".." ||
      filename !== basename(filename) ||
      filename.includes("\\") ||
      filename.includes("\0")
    ) {
      throw new ValidationError("Invalid backup filename");
    }

    const backupPath = join(this.backupDirectory, filename);
    const stats = lstatSync(backupPath, { throwIfNoEntry: false });
    if (!stats) throw new NotFoundError(`Backup not found: ${filename}`);
    if (!stats.isFile())
      throw new ValidationError("Backup must be a regular file");
    return backupPath;
  }

  private async runPostgresTool(command: "pg_dump" | "psql", args: string[]) {
    // libpq reads connection settings from the child environment. Credentials
    // never become shell text or appear in the command's argument list.
    await execFileAsync(command, args, {
      env: {
        ...process.env,
        PGHOST: env.POSTGRES_HOST,
        PGPORT: String(env.POSTGRES_PORT),
        PGUSER: env.POSTGRES_USER,
        PGDATABASE: env.POSTGRES_DB,
        PGPASSWORD: env.POSTGRES_PASSWORD,
      },
    });
  }

  /**
   * Create a new database backup using pg_dump
   */
  async createBackup(): Promise<BackupInfo> {
    if (env.DEMO_MODE) return backupDemoService.createBackup();
    mkdirSync(this.backupDirectory, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `backup-${timestamp}-${randomUUID()}.sql`;
    const backupPath = join(this.backupDirectory, filename);
    const temporaryPath = `${backupPath}.partial`;

    try {
      await this.runPostgresTool("pg_dump", ["-F", "p", "-f", temporaryPath]);
      renameSync(temporaryPath, backupPath);

      const stats = statSync(backupPath);

      logger.info(
        { filename, sizeBytes: stats.size },
        "Database backup created"
      );

      return {
        filename,
        path: backupPath,
        sizeBytes: stats.size,
        createdAt: new Date().toISOString(),
      };
    } catch (error) {
      try {
        rmSync(temporaryPath, { force: true });
      } catch (cleanupError) {
        logger.warn(
          { error: cleanupError, filename },
          "Failed to remove partial backup"
        );
      }
      logger.error({ error }, "Failed to create backup");
      throw new ValidationError(
        "Failed to create database backup. Ensure pg_dump is available."
      );
    }
  }

  /**
   * List all available backups
   */
  listBackups(): BackupInfo[] {
    if (env.DEMO_MODE) return backupDemoService.listBackups();
    mkdirSync(this.backupDirectory, { recursive: true });

    const files = readdirSync(this.backupDirectory, {
      withFileTypes: true,
    }).filter(
      (file) =>
        file.isFile() &&
        (file.name.endsWith(".sql") || file.name.endsWith(".db"))
    );

    return files
      .map(({ name: filename }) => {
        const fullPath = join(this.backupDirectory, filename);
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
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
  }

  /**
   * Restore from a backup file using psql
   */
  async restoreBackup(filename: string): Promise<void> {
    if (env.DEMO_MODE) return backupDemoService.restoreBackup(filename);
    const backupPath = this.existingBackupPath(filename);

    try {
      await this.runPostgresTool("psql", [
        "--no-psqlrc",
        "--quiet",
        "--set=ON_ERROR_STOP=1",
        "-f",
        backupPath,
      ]);

      logger.info({ filename }, "Database restored from backup");
    } catch (error) {
      logger.error({ error, filename }, "Failed to restore backup");
      throw new ValidationError(
        "Failed to restore database from backup. Ensure psql is available."
      );
    }
  }

  /**
   * Delete a backup file
   */
  deleteBackup(filename: string): void {
    if (env.DEMO_MODE) return backupDemoService.deleteBackup(filename);
    const backupPath = this.existingBackupPath(filename);

    unlinkSync(backupPath);
    logger.info({ filename }, "Backup deleted");
  }

  /**
   * Export entire database as JSON
   */
  async exportToJson(): Promise<ExportData> {
    if (env.DEMO_MODE) return backupDemoService.exportToJson();
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
      creatorFavorites,
      bookmarks,
    ] = await Promise.all([
      db
        .select({
          id: usersTable.id,
          name: usersTable.name,
          email: usersTable.email,
          emailVerified: usersTable.emailVerified,
          image: usersTable.image,
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
      db.select().from(creatorFavoritesTable),
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
        creator_favorites: creatorFavorites,
        bookmarks,
      },
    };
  }
}

export const backupService = new BackupService();
