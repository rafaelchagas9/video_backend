import { copyFileSync, existsSync, mkdirSync, unlinkSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";
import { getDatabase, closeDatabase } from "@/config/database";
import { env } from "@/config/env";
import { NotFoundError, ValidationError } from "@/utils/errors";
import { logger } from "@/utils/logger";
import type { BackupInfo, ExportData } from "./backup.types";

const BACKUP_DIR = resolve(process.cwd(), "./data/backups");

export class BackupService {
  private get db() {
    return getDatabase();
  }

  /**
   * Ensure backup directory exists
   */
  private ensureBackupDir(): void {
    if (!existsSync(BACKUP_DIR)) {
      mkdirSync(BACKUP_DIR, { recursive: true });
    }
  }

  /**
   * Create a new database backup
   */
  async createBackup(): Promise<BackupInfo> {
    this.ensureBackupDir();

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `backup-${timestamp}.db`;
    const backupPath = join(BACKUP_DIR, filename);
    const dbPath = resolve(process.cwd(), env.DATABASE_PATH);

    try {
      // SQLite backup - checkpoint WAL and copy
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      copyFileSync(dbPath, backupPath);

      const stats = statSync(backupPath);

      logger.info({ filename, sizeBytes: stats.size }, "Database backup created");

      return {
        filename,
        path: backupPath,
        sizeBytes: stats.size,
        createdAt: new Date().toISOString(),
      };
    } catch (error) {
      logger.error({ error }, "Failed to create backup");
      throw new ValidationError("Failed to create database backup");
    }
  }

  /**
   * List all available backups
   */
  listBackups(): BackupInfo[] {
    this.ensureBackupDir();

    const files = readdirSync(BACKUP_DIR).filter((f) => f.endsWith(".db"));

    return files.map((filename) => {
      const fullPath = join(BACKUP_DIR, filename);
      const stats = statSync(fullPath);

      return {
        filename,
        path: fullPath,
        sizeBytes: stats.size,
        createdAt: stats.mtime.toISOString(),
      };
    }).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  /**
   * Restore from a backup file
   */
  async restoreBackup(filename: string): Promise<void> {
    const backupPath = join(BACKUP_DIR, filename);

    if (!existsSync(backupPath)) {
      throw new NotFoundError(`Backup not found: ${filename}`);
    }

    const dbPath = resolve(process.cwd(), env.DATABASE_PATH);

    try {
      // Close current database connection
      closeDatabase();

      // Copy backup over current database
      copyFileSync(backupPath, dbPath);

      // Force reconnection
      getDatabase();

      logger.info({ filename }, "Database restored from backup");
    } catch (error) {
      logger.error({ error, filename }, "Failed to restore backup");
      throw new ValidationError("Failed to restore database from backup");
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
  exportToJson(): ExportData {
    const tables = {
      users: this.db.prepare("SELECT id, username, created_at, updated_at FROM users").all(),
      directories: this.db.prepare("SELECT * FROM watched_directories").all(),
      videos: this.db.prepare("SELECT * FROM videos").all(),
      creators: this.db.prepare("SELECT * FROM creators").all(),
      tags: this.db.prepare("SELECT * FROM tags").all(),
      ratings: this.db.prepare("SELECT * FROM ratings").all(),
      playlists: this.db.prepare("SELECT * FROM playlists").all(),
      favorites: this.db.prepare("SELECT * FROM favorites").all(),
      bookmarks: this.db.prepare("SELECT * FROM bookmarks").all(),
    };

    logger.info("Database exported to JSON");

    return {
      exportedAt: new Date().toISOString(),
      version: "0.1.0",
      tables,
    };
  }
}

export const backupService = new BackupService();
