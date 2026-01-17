import { existsSync } from "fs";
import { stat, access, constants } from "fs/promises";
import { resolve } from "path";
import { db } from "@/config/drizzle";
import { watchedDirectoriesTable, videosTable } from "@/database/schema";
import { eq, count, sql } from "drizzle-orm";
import { NotFoundError, ValidationError, ConflictError } from "@/utils/errors";
import type {
  CreateDirectoryInput,
  UpdateDirectoryInput,
  Directory,
  DirectoryStats,
} from "./directories.types";

export class DirectoriesService {
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
      if (error.code === "EACCES") {
        throw new ValidationError(
          `No read permission for directory: ${normalizedPath}`,
        );
      }
      throw error;
    }

    // Check if already registered
    const existing = await db.query.watchedDirectoriesTable.findFirst({
      where: (dirs, { eq }) => eq(dirs.path, normalizedPath),
      columns: { id: true },
    });

    if (existing) {
      throw new ConflictError(
        `Directory already registered: ${normalizedPath}`,
      );
    }

    // Create directory record
    const [result] = await db
      .insert(watchedDirectoriesTable)
      .values({
        path: normalizedPath,
        autoScan: input.auto_scan ?? true,
        scanIntervalMinutes: input.scan_interval_minutes ?? 30,
      })
      .returning();

    if (!result) {
      throw new Error("Failed to create directory record");
    }

    return {
      id: result.id,
      path: result.path,
      is_active: result.isActive,
      auto_scan: result.autoScan,
      scan_interval_minutes: result.scanIntervalMinutes,
      last_scan_at: result.lastScanAt?.toISOString() ?? null,
      added_at: result.addedAt.toISOString(),
      updated_at: result.updatedAt.toISOString(),
    };
  }

  async findAll(): Promise<Directory[]> {
    const results = await db.query.watchedDirectoriesTable.findMany({
      orderBy: (dirs, { desc }) => [desc(dirs.addedAt)],
    });

    return results.map((dir) => ({
      id: dir.id,
      path: dir.path,
      is_active: dir.isActive,
      auto_scan: dir.autoScan,
      scan_interval_minutes: dir.scanIntervalMinutes,
      last_scan_at: dir.lastScanAt?.toISOString() ?? null,
      added_at: dir.addedAt.toISOString(),
      updated_at: dir.updatedAt.toISOString(),
    }));
  }

  async findById(id: number): Promise<Directory> {
    const directory = await db.query.watchedDirectoriesTable.findFirst({
      where: (dirs, { eq }) => eq(dirs.id, id),
    });

    if (!directory) {
      throw new NotFoundError(`Directory not found with id: ${id}`);
    }

    return {
      id: directory.id,
      path: directory.path,
      is_active: directory.isActive,
      auto_scan: directory.autoScan,
      scan_interval_minutes: directory.scanIntervalMinutes,
      last_scan_at: directory.lastScanAt?.toISOString() ?? null,
      added_at: directory.addedAt.toISOString(),
      updated_at: directory.updatedAt.toISOString(),
    };
  }

  async update(id: number, input: UpdateDirectoryInput): Promise<Directory> {
    await this.findById(id); // Ensure exists

    const updateData: Partial<typeof watchedDirectoriesTable.$inferInsert> = {};

    if (input.is_active !== undefined) {
      updateData.isActive = input.is_active;
    }

    if (input.auto_scan !== undefined) {
      updateData.autoScan = input.auto_scan;
    }

    if (input.scan_interval_minutes !== undefined) {
      updateData.scanIntervalMinutes = input.scan_interval_minutes;
    }

    if (Object.keys(updateData).length === 0) {
      return this.findById(id);
    }

    updateData.updatedAt = new Date();

    await db
      .update(watchedDirectoriesTable)
      .set(updateData)
      .where(eq(watchedDirectoriesTable.id, id));

    return this.findById(id);
  }

  async delete(id: number): Promise<void> {
    await this.findById(id); // Ensure exists

    await db
      .delete(watchedDirectoriesTable)
      .where(eq(watchedDirectoriesTable.id, id));
  }

  async getStats(id: number): Promise<DirectoryStats> {
    await this.findById(id); // Ensure exists

    const [stats] = await db
      .select({
        directory_id: sql<number>`${id}`,
        total_videos: count(),
        total_size_bytes: sql<number>`COALESCE(SUM(${videosTable.fileSizeBytes}), 0)`,
        available_videos: sql<number>`SUM(CASE WHEN ${videosTable.isAvailable} = true THEN 1 ELSE 0 END)`,
        unavailable_videos: sql<number>`SUM(CASE WHEN ${videosTable.isAvailable} = false THEN 1 ELSE 0 END)`,
      })
      .from(videosTable)
      .where(eq(videosTable.directoryId, id));

    if (!stats) {
      throw new Error("Failed to get directory stats");
    }

    return stats;
  }

  async updateLastScanTime(id: number): Promise<void> {
    await db
      .update(watchedDirectoriesTable)
      .set({ lastScanAt: new Date() })
      .where(eq(watchedDirectoriesTable.id, id));
  }
}

export const directoriesService = new DirectoriesService();
