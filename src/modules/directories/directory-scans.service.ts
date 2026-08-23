import { count, desc, eq } from "drizzle-orm";
import { db } from "@/config/drizzle";
import { env } from "@/config/env";
import { scanLogsTable } from "@/database/schema";
import { NotFoundError } from "@/utils/errors";
import { sanitizeTelemetryProperties } from "@/utils/telemetry";
import { directoriesDemoService } from "./directories.demo.service";
import type { ScanResult, ScanRun, ScanRunPage } from "./directories.types";

const MAX_PUBLIC_ERRORS = 5;
const MAX_PUBLIC_ERROR_LENGTH = 512;

type ScanLogRow = typeof scanLogsTable.$inferSelect;

function publicErrorSummary(value: unknown): string {
  const sanitized = sanitizeTelemetryProperties({ error: String(value) }).error;
  return String(sanitized).slice(0, MAX_PUBLIC_ERROR_LENGTH);
}

function parseErrors(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [publicErrorSummary(value)];
    return parsed.map(publicErrorSummary);
  } catch {
    return [publicErrorSummary(value)];
  }
}

export function mapScanLogToRun(row: ScanLogRow): ScanRun {
  const errors = parseErrors(row.errors);
  return {
    id: row.id,
    directory_id: row.directoryId,
    status: row.completedAt ? "completed" : "running",
    files_found: row.filesFound,
    files_added: row.filesAdded,
    files_updated: row.filesUpdated,
    files_removed: row.filesRemoved,
    error_count: errors.length,
    error_summaries: errors.slice(0, MAX_PUBLIC_ERRORS),
    started_at: row.startedAt.toISOString(),
    completed_at: row.completedAt?.toISOString() ?? null,
  };
}

export class DirectoryScansService {
  async create(directoryId: number): Promise<ScanRun> {
    if (env.DEMO_MODE) return directoriesDemoService.createScanRun(directoryId);
    const [row] = await db
      .insert(scanLogsTable)
      .values({ directoryId, startedAt: new Date() })
      .returning();
    if (!row) throw new Error("Failed to create scan log");
    return mapScanLogToRun(row);
  }

  async complete(id: number, result: ScanResult): Promise<ScanRun> {
    if (env.DEMO_MODE) return directoriesDemoService.completeScanRun(id, result);
    const [row] = await db
      .update(scanLogsTable)
      .set({
        completedAt: new Date(),
        filesFound: result.files_found,
        filesAdded: result.files_added,
        filesUpdated: result.files_updated,
        filesRemoved: result.files_removed,
        errors: JSON.stringify(result.errors),
      })
      .where(eq(scanLogsTable.id, id))
      .returning();
    if (!row) throw new NotFoundError(`Scan run not found with id: ${id}`);
    return mapScanLogToRun(row);
  }

  async list(directoryId: number, page: number, limit: number): Promise<ScanRunPage> {
    if (env.DEMO_MODE) return directoriesDemoService.listScanRuns(directoryId, page, limit);
    const offset = (page - 1) * limit;
    const [rows, totals] = await Promise.all([
      db.select().from(scanLogsTable)
        .where(eq(scanLogsTable.directoryId, directoryId))
        .orderBy(desc(scanLogsTable.startedAt), desc(scanLogsTable.id))
        .limit(limit).offset(offset),
      db.select({ total: count() }).from(scanLogsTable)
        .where(eq(scanLogsTable.directoryId, directoryId)),
    ]);
    const total = Number(totals[0]?.total ?? 0);
    return {
      data: rows.map(mapScanLogToRun),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async findById(directoryId: number, scanId: number): Promise<ScanRun> {
    if (env.DEMO_MODE) return directoriesDemoService.findScanRun(directoryId, scanId);
    const row = await db.query.scanLogsTable.findFirst({
      where: (scan, operators) => operators.and(
        operators.eq(scan.id, scanId),
        operators.eq(scan.directoryId, directoryId),
      ),
    });
    if (!row) throw new NotFoundError(`Scan run not found with id: ${scanId}`);
    return mapScanLogToRun(row);
  }
}

export const directoryScansService = new DirectoryScansService();
