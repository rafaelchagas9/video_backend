import { and, desc, eq, sql } from "drizzle-orm";
import { demoSchema, getDemoDatabase } from "@/database/demo";
import { ConflictError, NotFoundError } from "@/utils/errors";
import { sanitizeTelemetryProperties } from "@/utils/telemetry";
import type {
  CreateDirectoryInput,
  Directory,
  DirectoryStats,
  UpdateDirectoryInput,
  ScanResult,
  ScanRun,
  ScanRunPage,
} from "./directories.types";

const { demoResourcesTable, demoVideosTable } = demoSchema;
const RESOURCE_KIND = "directory";
const SCAN_RESOURCE_KIND = "directory_scan";

interface StoredDemoScanRun extends Omit<ScanRun, "error_count" | "error_summaries"> {
  errors: string[];
}

function now(): string {
  return new Date().toISOString();
}

function parseDirectory(payload: string): Directory {
  return JSON.parse(payload) as Directory;
}

function toPublicScanRun(run: StoredDemoScanRun): ScanRun {
  const summaries = run.errors.map((error) =>
    String(sanitizeTelemetryProperties({ error }).error).slice(0, 512)
  );
  const { errors: _errors, ...publicRun } = run;
  return {
    ...publicRun,
    error_count: summaries.length,
    error_summaries: summaries.slice(0, 5),
  };
}

/** Virtual watched-directory state backed by demo_resources. */
export class DirectoriesDemoService {
  private scanningDirectories = new Set<number>();

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
    if (existing) {
      this.ensureSeededScanHistory();
      return;
    }
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
    this.ensureSeededScanHistory();
  }

  private ensureSeededScanHistory(): void {
    const database = getDemoDatabase();
    const existing = database
      .select({ id: demoResourcesTable.id })
      .from(demoResourcesTable)
      .where(
        and(
          eq(demoResourcesTable.kind, SCAN_RESOURCE_KIND),
          eq(demoResourcesTable.id, "1")
        )
      )
      .get();
    if (existing) return;
    this.persistScanRun({
      id: 1,
      directory_id: 1,
      status: "completed",
      files_found: 132,
      files_added: 132,
      files_updated: 0,
      files_removed: 0,
      errors: [],
      started_at: "2026-01-01T00:00:00.000Z",
      completed_at: "2026-01-01T00:00:05.000Z",
    });
    this.persistScanRun({
      id: 2,
      directory_id: 1,
      status: "completed",
      files_found: 132,
      files_added: 0,
      files_updated: 0,
      files_removed: 0,
      errors: [],
      started_at: "2026-01-02T00:00:00.000Z",
      completed_at: "2026-01-02T00:00:01.000Z",
    });
  }

  private persistScanRun(run: StoredDemoScanRun): void {
    getDemoDatabase()
      .insert(demoResourcesTable)
      .values({
        kind: SCAN_RESOURCE_KIND,
        id: String(run.id),
        payloadJson: JSON.stringify(run),
        createdAt: run.started_at,
        updatedAt: run.completed_at ?? run.started_at,
      })
      .onConflictDoUpdate({
        target: [demoResourcesTable.kind, demoResourcesTable.id],
        set: {
          payloadJson: JSON.stringify(run),
          updatedAt: run.completed_at ?? run.started_at,
        },
      })
      .run();
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
    for (const run of this.listStoredScanRuns().filter((item) => item.directory_id === id)) {
      getDemoDatabase()
        .delete(demoResourcesTable)
        .where(
          and(
            eq(demoResourcesTable.kind, SCAN_RESOURCE_KIND),
            eq(demoResourcesTable.id, String(run.id))
          )
        )
        .run();
    }
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

  private listStoredScanRuns(): StoredDemoScanRun[] {
    return getDemoDatabase()
      .select({ payload: demoResourcesTable.payloadJson })
      .from(demoResourcesTable)
      .where(eq(demoResourcesTable.kind, SCAN_RESOURCE_KIND))
      .all()
      .flatMap((row) => {
        try {
          return [JSON.parse(row.payload) as StoredDemoScanRun];
        } catch {
          return [];
        }
      });
  }

  createScanRun(directoryId: number): ScanRun {
    this.findById(directoryId);
    const nextId = this.listStoredScanRuns().reduce(
      (maximum, run) => Math.max(maximum, run.id),
      0
    ) + 1;
    const run: StoredDemoScanRun = {
      id: nextId,
      directory_id: directoryId,
      status: "running",
      files_found: 0,
      files_added: 0,
      files_updated: 0,
      files_removed: 0,
      errors: [],
      started_at: now(),
      completed_at: null,
    };
    this.persistScanRun(run);
    return toPublicScanRun(run);
  }

  completeScanRun(id: number, result: ScanResult): ScanRun {
    const existing = this.listStoredScanRuns().find((run) => run.id === id);
    if (!existing) throw new NotFoundError(`Scan run not found with id: ${id}`);
    const completed: StoredDemoScanRun = {
      ...existing,
      status: "completed",
      files_found: result.files_found,
      files_added: result.files_added,
      files_updated: result.files_updated,
      files_removed: result.files_removed,
      errors: result.errors,
      completed_at: now(),
    };
    this.persistScanRun(completed);
    return toPublicScanRun(completed);
  }

  listScanRuns(directoryId: number, page: number, limit: number): ScanRunPage {
    this.findById(directoryId);
    const runs = this.listStoredScanRuns()
      .filter((run) => run.directory_id === directoryId)
      .sort((left, right) =>
        right.started_at.localeCompare(left.started_at) || right.id - left.id
      );
    const total = runs.length;
    return {
      data: runs.slice((page - 1) * limit, page * limit).map(toPublicScanRun),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  findScanRun(directoryId: number, scanId: number): ScanRun {
    this.findById(directoryId);
    const run = this.listStoredScanRuns().find(
      (item) => item.id === scanId && item.directory_id === directoryId
    );
    if (!run) throw new NotFoundError(`Scan run not found with id: ${scanId}`);
    return toPublicScanRun(run);
  }

  startScan(directoryId: number): { run: ScanRun; completion: Promise<ScanResult> } {
    if (this.scanningDirectories.has(directoryId)) {
      throw new ConflictError("Directory scan already in progress");
    }
    this.scanningDirectories.add(directoryId);
    try {
      const run = this.createScanRun(directoryId);
      const completion = Promise.resolve()
        .then(() => this.virtualScan(directoryId))
        .then((result) => {
          const scanResult: ScanResult = { ...result, files_removed: 0 };
          this.completeScanRun(run.id, scanResult);
          return scanResult;
        })
        .finally(() => this.scanningDirectories.delete(directoryId));
      return { run, completion };
    } catch (error) {
      this.scanningDirectories.delete(directoryId);
      throw error;
    }
  }
}

export const directoriesDemoService = new DirectoriesDemoService();
