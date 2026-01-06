import { existsSync } from 'fs';
import { stat, access, constants } from 'fs/promises';
import { resolve } from 'path';
import { getDatabase } from '@/config/database';
import {
  NotFoundError,
  ValidationError,
  ConflictError,
} from '@/utils/errors';
import type {
  CreateDirectoryInput,
  UpdateDirectoryInput,
  Directory,
  DirectoryStats,
} from './directories.types';

export class DirectoriesService {
  private get db() {
    return getDatabase();
  }

  async create(input: CreateDirectoryInput): Promise<Directory> {
    // Normalize path
    const normalizedPath = resolve(input.path);

    // Validate path exists
    if (!existsSync(normalizedPath)) {
      throw new ValidationError(`Directory does not exist: ${normalizedPath}`);
    }

    // Check if it's a directory
    try {
      const stats = await stat(normalizedPath);
      if (!stats.isDirectory()) {
        throw new ValidationError(`Path is not a directory: ${normalizedPath}`);
      }

      // Check read permissions
      await access(normalizedPath, constants.R_OK);
    } catch (error: any) {
      if (error.code === 'EACCES') {
        throw new ValidationError(
          `No read permission for directory: ${normalizedPath}`
        );
      }
      throw error;
    }

    // Check if already registered
    const existing = this.db
      .prepare('SELECT id FROM watched_directories WHERE path = ?')
      .get(normalizedPath);

    if (existing) {
      throw new ConflictError(`Directory already registered: ${normalizedPath}`);
    }

    // Create directory record
    const result = this.db
      .prepare(
        `INSERT INTO watched_directories (path, auto_scan, scan_interval_minutes)
         VALUES (?, ?, ?)
         RETURNING id, path, is_active, auto_scan, scan_interval_minutes,
                   last_scan_at, added_at, updated_at`
      )
      .get(
        normalizedPath,
        input.auto_scan ? 1 : 0,
        input.scan_interval_minutes
      ) as Directory;

    return result;
  }

  async findAll(): Promise<Directory[]> {
    return this.db
      .prepare(
        `SELECT id, path, is_active, auto_scan, scan_interval_minutes,
                last_scan_at, added_at, updated_at
         FROM watched_directories
         ORDER BY added_at DESC`
      )
      .all() as Directory[];
  }

  async findById(id: number): Promise<Directory> {
    const directory = this.db
      .prepare(
        `SELECT id, path, is_active, auto_scan, scan_interval_minutes,
                last_scan_at, added_at, updated_at
         FROM watched_directories
         WHERE id = ?`
      )
      .get(id) as Directory | undefined;

    if (!directory) {
      throw new NotFoundError(`Directory not found with id: ${id}`);
    }

    return directory;
  }

  async update(id: number, input: UpdateDirectoryInput): Promise<Directory> {
    await this.findById(id); // Ensure exists

    const updates: string[] = [];
    const values: any[] = [];

    if (input.is_active !== undefined) {
      updates.push('is_active = ?');
      values.push(input.is_active ? 1 : 0);
    }

    if (input.auto_scan !== undefined) {
      updates.push('auto_scan = ?');
      values.push(input.auto_scan ? 1 : 0);
    }

    if (input.scan_interval_minutes !== undefined) {
      updates.push('scan_interval_minutes = ?');
      values.push(input.scan_interval_minutes);
    }

    updates.push("updated_at = datetime('now')");

    if (updates.length === 1) {
      // Only updated_at changed
      return this.findById(id);
    }

    values.push(id);

    this.db
      .prepare(
        `UPDATE watched_directories
         SET ${updates.join(', ')}
         WHERE id = ?`
      )
      .run(...values);

    return this.findById(id);
  }

  async delete(id: number): Promise<void> {
    await this.findById(id); // Ensure exists

    this.db
      .prepare('DELETE FROM watched_directories WHERE id = ?')
      .run(id);
  }

  async getStats(id: number): Promise<DirectoryStats> {
    await this.findById(id); // Ensure exists

    const stats = this.db
      .prepare(
        `SELECT
           ? as directory_id,
           COUNT(*) as total_videos,
           COALESCE(SUM(file_size_bytes), 0) as total_size_bytes,
           SUM(CASE WHEN is_available = 1 THEN 1 ELSE 0 END) as available_videos,
           SUM(CASE WHEN is_available = 0 THEN 1 ELSE 0 END) as unavailable_videos
         FROM videos
         WHERE directory_id = ?`
      )
      .get(id, id) as DirectoryStats;

    return stats;
  }

  async updateLastScanTime(id: number): Promise<void> {
    this.db
      .prepare(
        "UPDATE watched_directories SET last_scan_at = datetime('now') WHERE id = ?"
      )
      .run(id);
  }
}

export const directoriesService = new DirectoriesService();
