import { and, desc, eq, sql } from "drizzle-orm";
import { demoSchema, getDemoDatabase } from "@/database/demo";
import { ConflictError, NotFoundError } from "@/utils/errors";
import type {
  CreateDirectoryInput,
  Directory,
  DirectoryStats,
  UpdateDirectoryInput,
} from "./directories.types";

const { demoResourcesTable, demoVideosTable } = demoSchema;
const RESOURCE_KIND = "directory";

function now(): string {
  return new Date().toISOString();
}

function parseDirectory(payload: string): Directory {
  return JSON.parse(payload) as Directory;
}

/** Virtual watched-directory state backed by demo_resources. */
export class DirectoriesDemoService {
  private ensureDefault(): void {
    const existing = getDemoDatabase()
      .select({ id: demoResourcesTable.id })
      .from(demoResourcesTable)
      .where(
        and(
          eq(demoResourcesTable.kind, RESOURCE_KIND),
          eq(demoResourcesTable.id, "1")
        )
      )
      .get();
    if (existing) return;
    const timestamp = "2026-01-01T00:00:00.000Z";
    const directory: Directory = {
      id: 1,
      path: "demo_mode/video",
      is_active: true,
      auto_scan: false,
      scan_interval_minutes: 30,
      last_scan_at: timestamp,
      added_at: timestamp,
      updated_at: timestamp,
    };
    this.persist(directory);
  }

  private persist(directory: Directory): void {
    getDemoDatabase()
      .insert(demoResourcesTable)
      .values({
        kind: RESOURCE_KIND,
        id: String(directory.id),
        payloadJson: JSON.stringify(directory),
        createdAt: directory.added_at,
        updatedAt: directory.updated_at,
      })
      .onConflictDoUpdate({
        target: [demoResourcesTable.kind, demoResourcesTable.id],
        set: {
          payloadJson: JSON.stringify(directory),
          updatedAt: directory.updated_at,
        },
      })
      .run();
  }

  create(input: CreateDirectoryInput): Directory {
    this.ensureDefault();
    const normalizedPath = input.path.trim().replace(/\/+$/, "");
    const existing = this.findAll().find(
      (directory) => directory.path === normalizedPath
    );
    if (existing)
      throw new ConflictError(
        `Directory already registered: ${normalizedPath}`
      );
    const maxId = this.findAll().reduce(
      (maximum, directory) => Math.max(maximum, directory.id),
      0
    );
    const timestamp = now();
    const directory: Directory = {
      id: maxId + 1,
      path: normalizedPath,
      is_active: true,
      auto_scan: input.auto_scan ?? true,
      scan_interval_minutes: input.scan_interval_minutes ?? 30,
      last_scan_at: null,
      added_at: timestamp,
      updated_at: timestamp,
    };
    this.persist(directory);
    return directory;
  }

  findAll(): Directory[] {
    this.ensureDefault();
    return getDemoDatabase()
      .select({ payload: demoResourcesTable.payloadJson })
      .from(demoResourcesTable)
      .where(eq(demoResourcesTable.kind, RESOURCE_KIND))
      .orderBy(desc(demoResourcesTable.createdAt))
      .all()
      .map((row) => parseDirectory(row.payload));
  }

  findById(id: number): Directory {
    this.ensureDefault();
    const row = getDemoDatabase()
      .select({ payload: demoResourcesTable.payloadJson })
      .from(demoResourcesTable)
      .where(
        and(
          eq(demoResourcesTable.kind, RESOURCE_KIND),
          eq(demoResourcesTable.id, String(id))
        )
      )
      .get();
    if (!row) throw new NotFoundError(`Directory not found with id: ${id}`);
    return parseDirectory(row.payload);
  }

  update(id: number, input: UpdateDirectoryInput): Directory {
    const existing = this.findById(id);
    const updated: Directory = {
      ...existing,
      is_active: input.is_active ?? existing.is_active,
      auto_scan: input.auto_scan ?? existing.auto_scan,
      scan_interval_minutes:
        input.scan_interval_minutes ?? existing.scan_interval_minutes,
      updated_at: now(),
    };
    this.persist(updated);
    return updated;
  }

  delete(id: number): void {
    this.findById(id);
    getDemoDatabase()
      .delete(demoResourcesTable)
      .where(
        and(
          eq(demoResourcesTable.kind, RESOURCE_KIND),
          eq(demoResourcesTable.id, String(id))
        )
      )
      .run();
  }

  getStats(id: number): DirectoryStats {
    this.findById(id);
    const row = getDemoDatabase()
      .select({
        totalVideos: sql<number>`count(*)`,
        totalSizeBytes: sql<number>`coalesce(sum(${demoVideosTable.fileSizeBytes}), 0)`,
        availableVideos: sql<number>`coalesce(sum(case when ${demoVideosTable.isAvailable} then 1 else 0 end), 0)`,
        unavailableVideos: sql<number>`coalesce(sum(case when ${demoVideosTable.isAvailable} then 0 else 1 end), 0)`,
      })
      .from(demoVideosTable)
      .where(eq(demoVideosTable.directoryId, id))
      .get();
    return {
      directory_id: id,
      total_videos: Number(row?.totalVideos ?? 0),
      total_size_bytes: Number(row?.totalSizeBytes ?? 0),
      available_videos: Number(row?.availableVideos ?? 0),
      unavailable_videos: Number(row?.unavailableVideos ?? 0),
    };
  }

  virtualScan(id: number): {
    files_found: number;
    files_added: number;
    files_updated: number;
    files_skipped: number;
    errors: string[];
  } {
    const directory = this.findById(id);
    const timestamp = now();
    this.persist({
      ...directory,
      last_scan_at: timestamp,
      updated_at: timestamp,
    });
    const stats = this.getStats(id);
    return {
      files_found: stats.total_videos,
      files_added: 0,
      files_updated: 0,
      files_skipped: stats.total_videos,
      errors: [],
    };
  }
}

export const directoriesDemoService = new DirectoriesDemoService();
