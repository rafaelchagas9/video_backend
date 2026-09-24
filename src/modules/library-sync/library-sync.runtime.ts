import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  max,
  sql,
  type SQL,
} from "drizzle-orm";
import { z } from "zod";
import { db } from "@/config/drizzle";
import { env } from "@/config/env";
import {
  appSettingsTable,
  durableJobsTable,
  faceExtractionJobsTable,
  storyboardsTable,
  videosTable,
} from "@/database/schema";
import {
  DurableJobsService,
  DurableJobWorker,
  PostgresDurableJobStore,
  type DurableJob,
  type DurableJobHandlerContext,
  type DurableJobStatus,
} from "@/modules/durable-jobs";
import { getDurableFaceExtractionQueue } from "@/modules/face-recognition/face-extraction-durable.service";
import { perceptualCatalog } from "@/modules/perceptual-duplicates/perceptual-catalog";
import {
  CATALOG_REVISION,
  perceptualCatalogResultsSchema,
} from "@/modules/perceptual-duplicates/perceptual-catalog.schemas";
import {
  assertCopyEngineReady,
  COPY_ENGINE_NOT_READY_CODE,
  COPY_ENGINE_NOT_READY_REASON,
} from "@/modules/perceptual-duplicates/perceptual-readiness";
type PerceptualCatalogResults = z.infer<typeof perceptualCatalogResultsSchema>;
import { settingsService } from "@/modules/settings/settings.service";
import { storyboardsService } from "@/modules/storyboards/storyboards.service";
import { ConflictError, NotFoundError } from "@/utils/errors";
import { mediaWorkScheduler } from "@/utils/media-work-scheduler";
import { logger } from "@/utils/logger";
import { captureTelemetryException } from "@/utils/telemetry";
import type {
  LibrarySyncCounts,
  LibrarySyncProgress,
  LibrarySyncRecentItem,
  LibrarySyncRun,
  LibrarySyncServiceContract,
  LibrarySyncTask,
} from "./library-sync.types";

export const LIBRARY_SYNC_JOB_KIND = "library.sync";
/**
 * Checkpoints are executable state, not historical metadata. Including the
 * perceptual catalog revision prevents a worker upgrade from resuming an old
 * cursor and treating artifacts from a previous engine as current progress.
 */
export const LIBRARY_SYNC_GENERATION = `library-sync-v2:${CATALOG_REVISION}`;
const AUTO_SETTING = "library_sync_auto_perceptual";
const AUTO_WATERMARK = "library_sync_auto_perceptual_watermark_video_id";
const AUTO_GENERATION = "library_sync_auto_perceptual_generation";
const ACTIVE = ["queued", "running", "retry_wait"] as const;
const TASKS = ["perceptual", "faces", "storyboards"] as const;

type JobRow = typeof durableJobsTable.$inferSelect;
type Video = { id: number; filePath: string; durationSeconds: number | null };
type LegacyPayload = {
  version: 1;
  userId: number | null;
  tasks: LibrarySyncTask[];
  trigger: "manual" | "automatic";
  videoIds: number[];
};
type Payload = {
  version: 2;
  generation: string;
  userId: number | null;
  tasks: LibrarySyncTask[];
  trigger: "manual" | "automatic";
  videoIds: number[];
  autoAttempt?: number;
};
type AnyPayload = LegacyPayload | Payload;
type CheckpointData = {
  generation?: string;
  progress: LibrarySyncProgress;
  recentItems: LibrarySyncRecentItem[];
  taskIndex: number;
  videoIndex: number;
  resumeTaskIndex?: number;
  resumeVideoIndex?: number;
};

const legacyPayloadSchema = z
  .object({
    version: z.literal(1),
    userId: z.number().int().positive().nullable(),
    tasks: z.array(z.enum(TASKS)).min(1),
    trigger: z.enum(["manual", "automatic"]),
    videoIds: z.array(z.number().int().positive()),
  })
  .strict();
const payloadSchema = z
  .object({
    version: z.literal(2),
    generation: z.string().min(1),
    userId: z.number().int().positive().nullable(),
    tasks: z.array(z.enum(TASKS)).min(1),
    trigger: z.enum(["manual", "automatic"]),
    videoIds: z.array(z.number().int().positive()),
    autoAttempt: z.number().int().min(1).max(3).optional(),
  })
  .strict();
const checkpointDataSchema = z
  .object({
    generation: z.string().min(1).optional(),
    progress: z.any(),
    recentItems: z.array(z.any()),
    taskIndex: z.number().int().nonnegative(),
    videoIndex: z.number().int().nonnegative(),
    resumeTaskIndex: z.number().int().nonnegative().optional(),
    resumeVideoIndex: z.number().int().nonnegative().optional(),
  })
  .passthrough();

export interface LibrarySyncAdapters {
  perceptual: {
    processedIds(videos: Video[]): Promise<Set<number>>;
    process(
      videoId: number,
      signal: AbortSignal
    ): Promise<{
      compared_videos: number;
      retrieval_references?: number;
      retrieval_candidates?: number;
      retrieval_truncated?: boolean;
      match_count: number;
      truncated_matches: boolean;
    }>;
    results(input: {
      view?: "copies" | "similarity";
      limit: number;
      offset: number;
    }): Promise<PerceptualCatalogResults>;
  };
  faces: {
    processedIds(videoIds: number[]): Promise<Set<number>>;
    process(
      videoId: number,
      signal: AbortSignal
    ): Promise<{ faces_detected: number }>;
  };
  storyboards: {
    processedIds(videoIds: number[]): Promise<Set<number>>;
    process(videoId: number, signal: AbortSignal): Promise<{ generated: true }>;
  };
}

function durableJobs() {
  return new DurableJobsService(
    new PostgresDurableJobStore({
      async execute<Row extends Record<string, unknown>>(query: SQL) {
        return Array.from(await db.execute<Row>(query)) as Row[];
      },
    })
  );
}
function blankTask(total = 0) {
  return {
    total,
    processed: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    pending: total,
  };
}
function blankProgress(
  tasks: LibrarySyncTask[],
  videos: number[]
): LibrarySyncProgress {
  const byTask = {
    perceptual: blankTask(tasks.includes("perceptual") ? videos.length : 0),
    faces: blankTask(tasks.includes("faces") ? videos.length : 0),
    storyboards: blankTask(tasks.includes("storyboards") ? videos.length : 0),
  };
  const total = Object.values(byTask).reduce(
    (sum, item) => sum + item.total,
    0
  );
  return {
    total,
    processed: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    pending: total,
    current: null,
    byTask,
  };
}
function parsePayload(value: unknown): AnyPayload | null {
  const parsed = z.union([payloadSchema, legacyPayloadSchema]).safeParse(value);
  return parsed.success ? parsed.data : null;
}
function parseStoredCheckpoint(value: unknown): CheckpointData | null {
  if (!value || typeof value !== "object") return null;
  const data = (value as { data?: unknown }).data;
  const parsed = checkpointDataSchema.safeParse(data);
  return parsed.success ? (parsed.data as CheckpointData) : null;
}
function parseCheckpoint(value: unknown, generation: string) {
  const parsed = parseStoredCheckpoint(value);
  return parsed?.generation === generation ? parsed : null;
}

function totalsFromTasks(progress: LibrarySyncProgress): LibrarySyncProgress {
  const tasks = Object.values(progress.byTask);
  const total = tasks.reduce((sum, task) => sum + task.total, 0);
  const processed = tasks.reduce((sum, task) => sum + task.processed, 0);
  return {
    ...progress,
    total,
    processed,
    completed: tasks.reduce((sum, task) => sum + task.completed, 0),
    failed: tasks.reduce((sum, task) => sum + task.failed, 0),
    skipped: tasks.reduce((sum, task) => sum + task.skipped, 0),
    pending: Math.max(0, total - processed),
    current: null,
  };
}

/**
 * A perceptual revision invalidates only perceptual progress. Face and
 * storyboard artifacts use independent contracts and remain resumable.
 */
function checkpointForCurrentGeneration(
  payload: AnyPayload,
  value: unknown
): CheckpointData {
  const current = parseCheckpoint(value, LIBRARY_SYNC_GENERATION);
  if (current) return current;
  const stored = parseStoredCheckpoint(value);
  const initial: CheckpointData = stored
    ? structuredClone(stored)
    : {
        progress: blankProgress(payload.tasks, payload.videoIds),
        recentItems: [],
        taskIndex: 0,
        videoIndex: 0,
      };
  initial.generation = LIBRARY_SYNC_GENERATION;
  if (!payload.tasks.includes("perceptual")) return initial;

  const perceptualIndex = payload.tasks.indexOf("perceptual");
  const previousTaskIndex = Math.min(initial.taskIndex, payload.tasks.length);
  const previousVideoIndex = Math.min(
    initial.videoIndex,
    payload.videoIds.length
  );
  initial.progress.byTask.perceptual = blankTask(payload.videoIds.length);
  initial.progress = totalsFromTasks(initial.progress);
  initial.recentItems = initial.recentItems.filter(
    (item) => item.task !== "perceptual"
  );

  if (previousTaskIndex > perceptualIndex) {
    // Re-run invalidated perceptual work first, then continue the exact later
    // task/video cursor that the old worker had already reached.
    initial.taskIndex = perceptualIndex;
    initial.videoIndex = 0;
    initial.resumeTaskIndex = previousTaskIndex;
    initial.resumeVideoIndex = previousVideoIndex;
  } else if (previousTaskIndex === perceptualIndex) {
    initial.taskIndex = perceptualIndex;
    initial.videoIndex = 0;
  }
  return initial;
}

function isCurrentPayload(payload: AnyPayload | null): payload is Payload {
  return (
    payload?.version === 2 && payload.generation === LIBRARY_SYNC_GENERATION
  );
}
function safeStatus(value: string): DurableJobStatus {
  if (
    [
      "queued",
      "running",
      "retry_wait",
      "completed",
      "failed",
      "cancelled",
    ].includes(value)
  )
    return value as DurableJobStatus;
  throw new Error("Invalid library sync status");
}
function publicError(status: DurableJobStatus, value: unknown) {
  if (status !== "failed") return null;
  const raw =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const code = typeof raw.code === "string" ? raw.code : "LIBRARY_SYNC_FAILED";
    const messages: Record<string, string> = {
    COPY_MODEL_MISSING: "Perceptual duplicate model is unavailable",
    COPY_MODEL_INVALID: "Perceptual duplicate model is invalid",
    COPY_GPU_UNAVAILABLE: "Required GPU inference is unavailable",
    COPY_GPU_UNVERIFIED: "GPU inference could not be verified",
    COPY_PRECISION_INVALID: "GPU inference precision is invalid",
    COPY_CACHE_FULL: "Perceptual duplicate cache is full",
    COPY_ENGINE_NOT_READY: COPY_ENGINE_NOT_READY_REASON,
    ENGINE_UNAVAILABLE: "Perceptual duplicate engine is unavailable",
    COPY_DECODE_FAILED: "Video could not be decoded for perceptual analysis",
    COPY_SOURCE_CHANGED: "Video changed during perceptual analysis",
    COPY_CACHE_CORRUPT: "Perceptual duplicate cache is corrupt",
    COPY_ANALYSIS_FAILED: "Perceptual duplicate analysis failed",
    ENGINE_FAILED: "Perceptual duplicate engine failed",
    ENGINE_TIMEOUT: "Perceptual duplicate analysis timed out",
    ENGINE_OUTPUT_TOO_LARGE:
      "Perceptual duplicate engine exceeded its output limit",
    ENGINE_INVALID_RESULT:
      "Perceptual duplicate engine returned an invalid result",
    LIBRARY_SYNC_GENERATION_STALE:
      "This synchronization belongs to an earlier perceptual engine revision",
    LIBRARY_SYNC_FAILED: "Library synchronization failed",
  };
  return {
    code: messages[code] ? code : "LIBRARY_SYNC_FAILED",
    message: messages[code] ?? messages.LIBRARY_SYNC_FAILED,
  };
}
function mapJob(row: JobRow): LibrarySyncRun | null {
  if (row.kind !== LIBRARY_SYNC_JOB_KIND) return null;
  const payload = parsePayload(row.payload);
  if (!payload) return null;
  const status = safeStatus(row.status);
  const generation = payload.version === 2 ? payload.generation : null;
  // Historical checkpoints remain useful for display, but the handler below
  // accepts them for execution only when their generation matches exactly.
  const cp = parseStoredCheckpoint(row.checkpoint);
  const phase =
    status === "queued"
      ? "queued"
      : status === "completed"
        ? "completed"
        : status === "failed"
          ? "failed"
          : status === "cancelled"
            ? "cancelled"
            : row.checkpoint?.stage === "scanning"
              ? "scanning"
              : "executing";
  const storedProgress =
    cp?.progress ?? blankProgress(payload.tasks, payload.videoIds);
  const progress = ["completed", "failed", "cancelled"].includes(status)
    ? { ...storedProgress, current: null }
    : storedProgress;
  return {
    id: row.id,
    generation,
    tasks: payload.tasks,
    trigger: payload.trigger,
    status,
    phase,
    progress,
    recentItems: cp?.recentItems ?? [],
    error: publicError(status, row.lastError),
    retryCount: row.retryCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    cancelledAt: row.cancelledAt,
  };
}
async function regularReadable(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.R_OK);
    const source = await import("node:fs/promises").then((module) =>
      module.stat(path)
    );
    return source.isFile() && source.size > 0;
  } catch {
    return false;
  }
}
async function delay(ms: number, signal: AbortSignal) {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      callback();
    };
    const timer = setTimeout(() => finish(resolve), ms);
    const abort = () =>
      finish(() =>
        reject(signal.reason ?? new DOMException("Cancelled", "AbortError"))
      );
    signal.addEventListener("abort", abort, { once: true });
  });
}

function defaultAdapters(): LibrarySyncAdapters {
  return {
    perceptual: perceptualCatalog,
    faces: {
      async processedIds(videoIds) {
        if (!videoIds.length) return new Set();
        const rows = await db
          .select({ videoId: faceExtractionJobsTable.videoId })
          .from(faceExtractionJobsTable)
          .where(
            and(
              inArray(faceExtractionJobsTable.videoId, videoIds),
              eq(faceExtractionJobsTable.status, "completed")
            )
          );
        return new Set(rows.map((row) => row.videoId));
      },
      async process(videoId, signal) {
        const queue = getDurableFaceExtractionQueue();
        let run = await queue.getLatestJob(videoId);
        if (
          run?.status !== "completed" &&
          run?.status !== "pending" &&
          run?.status !== "processing"
        )
          run = await queue.queueExtraction(videoId);
        while (true) {
          if (signal.aborted) throw signal.reason;
          const current = await queue.getLatestJob(videoId);
          if (current?.status === "completed") {
            signal.throwIfAborted();
            return { faces_detected: current.facesDetected };
          }
          if (current?.status === "failed" || current?.status === "skipped")
            throw new Error("Face extraction did not complete");
          await delay(750, signal);
        }
      },
    },
    storyboards: {
      async processedIds(videoIds) {
        if (!videoIds.length) return new Set();
        const rows = await db
          .select({
            videoId: storyboardsTable.videoId,
            spritePath: storyboardsTable.spritePath,
            vttPath: storyboardsTable.vttPath,
          })
          .from(storyboardsTable)
          .where(inArray(storyboardsTable.videoId, videoIds));
        const found = new Set<number>();
        for (let offset = 0; offset < rows.length; offset += 16)
          await Promise.all(
            rows.slice(offset, offset + 16).map(async (row) => {
              if (
                (await regularReadable(row.spritePath)) &&
                (await regularReadable(row.vttPath))
              )
                found.add(row.videoId);
            })
          );
        return found;
      },
      async process(videoId, signal) {
        await mediaWorkScheduler.run(
          "background",
          () => storyboardsService.generate(videoId),
          signal
        );
        signal.throwIfAborted();
        return { generated: true };
      },
    },
  };
}

export class LibrarySyncRuntime implements LibrarySyncServiceContract {
  private readonly jobs: DurableJobsService;
  private readonly worker: DurableJobWorker;
  private readonly controllers = new Map<number, AbortController>();
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  constructor(
    private readonly adapters: LibrarySyncAdapters = defaultAdapters(),
    private readonly options: { perceptualEnabled?: boolean } = {}
  ) {
    this.jobs = durableJobs();
    this.worker = new DurableJobWorker(this.jobs, {
      workerId: `library-sync-${process.pid}`,
      leaseDurationMs: 60_000,
      heartbeatIntervalMs: 20_000,
      pollIntervalMs: 1_000,
      maxRetries: 1,
      kinds: [LIBRARY_SYNC_JOB_KIND],
      handlers: {
        [LIBRARY_SYNC_JOB_KIND]: (job, ctx) => this.handle(job, ctx),
      },
      classifyError: (error) => {
        const rawCode =
          typeof error === "object" &&
          error !== null &&
          typeof (error as { code?: unknown }).code === "string"
            ? String((error as { code: string }).code)
            : "LIBRARY_SYNC_FAILED";
        const allowed = new Set([
          "COPY_MODEL_MISSING",
          "COPY_MODEL_INVALID",
          "COPY_GPU_UNAVAILABLE",
          "COPY_GPU_UNVERIFIED",
          "COPY_PRECISION_INVALID",
          "COPY_CACHE_FULL",
          COPY_ENGINE_NOT_READY_CODE,
          "ENGINE_UNAVAILABLE",
          "LIBRARY_SYNC_GENERATION_STALE",
        ]);
        return {
          retryable: false,
          error: {
            code: allowed.has(rawCode) ? rawCode : "LIBRARY_SYNC_FAILED",
            message: "Library synchronization failed",
          },
        };
      },
    });
  }
  async start(): Promise<void> {
    if (this.perceptualEnabled) await this.ensureAutoBaseline();
    else await this.markAutoDisabled();
    await this.worker.start();
    await this.reconcileAutoQueue();
    if (this.reconcileTimer) return;
    this.reconcileTimer = setInterval(() => {
      void this.reconcileAutoQueue().catch((error) =>
        logger.warn({ error }, "Library sync automatic reconciliation failed")
      );
    }, 30_000);
    this.reconcileTimer.unref?.();
  }
  async stop(): Promise<void> {
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    await this.worker.stop();
  }
  async startRun(input: { tasks: LibrarySyncTask[]; userId: number }) {
    const tasks = [...new Set(input.tasks)].sort() as LibrarySyncTask[];
    if (tasks.includes("perceptual"))
      assertCopyEngineReady(this.perceptualEnabled);
    return db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended('library-sync-manual',0))`
      );
      const active = await tx
        .select()
        .from(durableJobsTable)
        .where(
          and(
            eq(durableJobsTable.kind, LIBRARY_SYNC_JOB_KIND),
            inArray(durableJobsTable.status, [...ACTIVE]),
            sql`${durableJobsTable.payload}->>'trigger' = 'manual'`
          )
        )
        .orderBy(asc(durableJobsTable.id));
      const equivalent = active.find((row) => {
        const p = parsePayload(row.payload);
        return (
          p && JSON.stringify([...p.tasks].sort()) === JSON.stringify(tasks)
        );
      });
      if (equivalent) {
        const run = mapJob(equivalent);
        if (run) return { run, reused: true };
      }
      if (active.length)
        throw new ConflictError(
          "A library synchronization run is already active"
        );
      const videos = await tx
        .select({ id: videosTable.id })
        .from(videosTable)
        .where(eq(videosTable.isAvailable, true))
        .orderBy(asc(videosTable.id));
      const payload: Payload = {
        version: 2,
        generation: LIBRARY_SYNC_GENERATION,
        userId: input.userId,
        tasks,
        trigger: "manual",
        videoIds: videos.map((v) => v.id),
      };
      const [created] = await tx
        .insert(durableJobsTable)
        .values({ kind: LIBRARY_SYNC_JOB_KIND, payload })
        .returning();
      const run = created && mapJob(created);
      if (!run) throw new Error("Could not create library sync run");
      return { run, reused: false };
    });
  }
  async getRun(id: number) {
    const [row] = await db
      .select()
      .from(durableJobsTable)
      .where(
        and(
          eq(durableJobsTable.id, id),
          eq(durableJobsTable.kind, LIBRARY_SYNC_JOB_KIND)
        )
      )
      .limit(1);
    const run = row && mapJob(row);
    if (!run) throw new NotFoundError("Library sync run not found");
    return run;
  }
  async cancelRun(id: number) {
    const current = await this.getRun(id);
    if (["completed", "failed", "cancelled"].includes(current.status))
      return current;
    await this.jobs.requestCancellation(id);
    this.controllers
      .get(id)
      ?.abort(new DOMException("Library sync cancelled", "AbortError"));
    return this.getRun(id);
  }
  async updateSettings(input: { autoPerceptual: boolean }) {
    if (input.autoPerceptual) assertCopyEngineReady(this.perceptualEnabled);
    await this.updateAutoSetting(input.autoPerceptual);
    return { autoPerceptual: input.autoPerceptual };
  }
  async perceptualResults(input: {
    limit: number;
    offset: number;
    view?: "copies" | "similarity";
  }) {
    return this.adapters.perceptual.results(input);
  }
  async overview() {
    const videos = await this.availableVideos();
    const ids = videos.map((v) => v.id);
    const [perceptual, faces, storyboards, rows, activeRows, auto] =
      await Promise.all([
        this.adapters.perceptual.processedIds(videos),
        this.adapters.faces.processedIds(ids),
        this.adapters.storyboards.processedIds(ids),
        db
          .select()
          .from(durableJobsTable)
          .where(eq(durableJobsTable.kind, LIBRARY_SYNC_JOB_KIND))
          .orderBy(desc(durableJobsTable.createdAt))
          .limit(20),
        db
          .select()
          .from(durableJobsTable)
          .where(
            and(
              eq(durableJobsTable.kind, LIBRARY_SYNC_JOB_KIND),
              inArray(durableJobsTable.status, [...ACTIVE])
            )
          )
          .orderBy(
            sql`CASE WHEN ${durableJobsTable.status} = 'running' THEN 0 ELSE 1 END`,
            sql`CASE WHEN ${durableJobsTable.payload}->>'trigger' = 'manual' THEN 0 ELSE 1 END`,
            asc(durableJobsTable.createdAt)
          )
          .limit(1),
        settingsService.getValue(AUTO_SETTING),
      ]);
    const count = (set: Set<number>) => ({
      pending: Math.max(0, ids.length - set.size),
      completed: set.size,
    });
    const runs = rows
      .map(mapJob)
      .filter((run): run is LibrarySyncRun => Boolean(run));
    const counts: LibrarySyncCounts = {
      totalVideos: ids.length,
      tasks: {
        perceptual: count(perceptual),
        faces: count(faces),
        storyboards: count(storyboards),
      },
    };
    return {
      generation: LIBRARY_SYNC_GENERATION,
      capabilities: {
        perceptual: {
          enabled: this.perceptualEnabled,
          code: this.perceptualEnabled ? null : COPY_ENGINE_NOT_READY_CODE,
          reason: this.perceptualEnabled ? null : COPY_ENGINE_NOT_READY_REASON,
        },
      },
      settings: { autoPerceptual: this.perceptualEnabled && auto !== false },
      counts,
      activeRun: activeRows[0] ? mapJob(activeRows[0]) : null,
      recentRuns: runs,
    };
  }
  async enqueueNewVideo(videoId: number): Promise<LibrarySyncRun | null> {
    if (!this.perceptualEnabled) return null;
    return db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended('library-sync-auto',0))`
      );
      const [setting] = await tx
        .select()
        .from(appSettingsTable)
        .where(eq(appSettingsTable.key, AUTO_SETTING))
        .limit(1);
      const enabled = setting ? setting.value !== "false" : true;
      const [watermark] = await tx
        .select()
        .from(appSettingsTable)
        .where(eq(appSettingsTable.key, AUTO_WATERMARK))
        .limit(1);
      const [generation] = await tx
        .select()
        .from(appSettingsTable)
        .where(eq(appSettingsTable.key, AUTO_GENERATION))
        .limit(1);
      if (!watermark || generation?.value !== LIBRARY_SYNC_GENERATION) {
        const [{ maxId }] = await tx
          .select({ maxId: max(videosTable.id) })
          .from(videosTable);
        await tx
          .insert(appSettingsTable)
          .values({ key: AUTO_WATERMARK, value: String(maxId ?? 0) })
          .onConflictDoUpdate({
            target: appSettingsTable.key,
            set: { value: String(maxId ?? 0), updatedAt: new Date() },
          });
        await tx
          .insert(appSettingsTable)
          .values({ key: AUTO_GENERATION, value: LIBRARY_SYNC_GENERATION })
          .onConflictDoUpdate({
            target: appSettingsTable.key,
            set: { value: LIBRARY_SYNC_GENERATION, updatedAt: new Date() },
          });
        return null;
      }
      if (!enabled || videoId <= Number(watermark.value)) return null;
      const [video] = await tx
        .select({
          id: videosTable.id,
          filePath: videosTable.filePath,
          durationSeconds: videosTable.durationSeconds,
        })
        .from(videosTable)
        .where(
          and(eq(videosTable.id, videoId), eq(videosTable.isAvailable, true))
        )
        .limit(1);
      if (!video) return null;
      if ((await this.adapters.perceptual.processedIds([video])).has(videoId))
        return null;
      const existing = await tx
        .select()
        .from(durableJobsTable)
        .where(
          and(
            eq(durableJobsTable.kind, LIBRARY_SYNC_JOB_KIND),
            sql`${durableJobsTable.payload}->>'trigger' = 'automatic'`,
            sql`${durableJobsTable.payload}->>'generation' = ${LIBRARY_SYNC_GENERATION}`,
            sql`${durableJobsTable.payload}->'videoIds' @> ${JSON.stringify([videoId])}::jsonb`
          )
        )
        .orderBy(desc(durableJobsTable.createdAt))
        .limit(1)
        .then((rows) => rows[0]);
      const existingRun = existing ? mapJob(existing) : null;
      if (
        existingRun &&
        ([...ACTIVE, "cancelled"] as string[]).includes(existingRun.status)
      )
        return existingRun;
      const previousPayload = existing ? parsePayload(existing.payload) : null;
      const previousAttempt = isCurrentPayload(previousPayload)
        ? (previousPayload.autoAttempt ?? 1)
        : 0;
      // A terminal automatic item may be retried by reconciliation, but the
      // cap prevents a permanently unreadable source from creating jobs every
      // thirty seconds. Cancellation is a user stop signal and is not retried.
      if (previousAttempt >= 3) return existingRun;
      const payload: Payload = {
        version: 2,
        generation: LIBRARY_SYNC_GENERATION,
        userId: null,
        tasks: ["perceptual"],
        trigger: "automatic",
        videoIds: [videoId],
        autoAttempt: previousAttempt + 1,
      };
      const [created] = await tx
        .insert(durableJobsTable)
        .values({ kind: LIBRARY_SYNC_JOB_KIND, payload })
        .returning();
      return created ? mapJob(created) : null;
    });
  }
  private async reconcileAutoQueue(): Promise<void> {
    if (!this.perceptualEnabled) return;
    const setting = await settingsService.getValue(AUTO_SETTING);
    if (setting === false) return;
    const [generation] = await db
      .select()
      .from(appSettingsTable)
      .where(eq(appSettingsTable.key, AUTO_GENERATION))
      .limit(1);
    if (generation?.value !== LIBRARY_SYNC_GENERATION) {
      await this.ensureAutoBaseline();
      return;
    }
    const [row] = await db
      .select()
      .from(appSettingsTable)
      .where(eq(appSettingsTable.key, AUTO_WATERMARK))
      .limit(1);
    if (!row) return;
    const baseline = Number(row.value) || 0;
    const pending = await db
      .select({
        id: videosTable.id,
        filePath: videosTable.filePath,
        durationSeconds: videosTable.durationSeconds,
      })
      .from(videosTable)
      .where(
        and(
          eq(videosTable.isAvailable, true),
          sql`${videosTable.id} > ${baseline}`
        )
      )
      .orderBy(asc(videosTable.id));
    const processed = await this.adapters.perceptual.processedIds(pending);
    for (const video of pending)
      if (!processed.has(video.id)) await this.enqueueNewVideo(video.id);
  }
  private async availableVideos(): Promise<Video[]> {
    return db
      .select({
        id: videosTable.id,
        filePath: videosTable.filePath,
        durationSeconds: videosTable.durationSeconds,
      })
      .from(videosTable)
      .where(eq(videosTable.isAvailable, true))
      .orderBy(asc(videosTable.id));
  }
  private async ensureAutoBaseline() {
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended('library-sync-auto',0))`
      );
      const [generation] = await tx
        .select()
        .from(appSettingsTable)
        .where(eq(appSettingsTable.key, AUTO_GENERATION))
        .limit(1);
      const [watermark] = await tx
        .select()
        .from(appSettingsTable)
        .where(eq(appSettingsTable.key, AUTO_WATERMARK))
        .limit(1);
      if (
        watermark &&
        generation?.value === LIBRARY_SYNC_GENERATION
      )
        return;
      const [{ maxId }] = await tx
        .select({ maxId: max(videosTable.id) })
        .from(videosTable);
      await tx
        .insert(appSettingsTable)
        .values({ key: AUTO_WATERMARK, value: String(maxId ?? 0) })
        .onConflictDoUpdate({
          target: appSettingsTable.key,
          set: { value: String(maxId ?? 0), updatedAt: new Date() },
        });
      await tx
        .insert(appSettingsTable)
        .values({ key: AUTO_GENERATION, value: LIBRARY_SYNC_GENERATION })
        .onConflictDoUpdate({
          target: appSettingsTable.key,
          set: { value: LIBRARY_SYNC_GENERATION, updatedAt: new Date() },
          });
    });
  }
  private async markAutoDisabled() {
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended('library-sync-auto',0))`
      );
      await tx
        .insert(appSettingsTable)
        .values({
          key: AUTO_GENERATION,
          value: `disabled:${LIBRARY_SYNC_GENERATION}`,
        })
        .onConflictDoUpdate({
          target: appSettingsTable.key,
          set: {
            value: `disabled:${LIBRARY_SYNC_GENERATION}`,
            updatedAt: new Date(),
          },
        });
    });
  }
  private async updateAutoSetting(enabled: boolean) {
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended('library-sync-auto',0))`
      );
      if (enabled) {
        const [{ maxId }] = await tx
          .select({ maxId: max(videosTable.id) })
          .from(videosTable);
        await tx
          .insert(appSettingsTable)
          .values({ key: AUTO_WATERMARK, value: String(maxId ?? 0) })
          .onConflictDoUpdate({
            target: appSettingsTable.key,
            set: { value: String(maxId ?? 0), updatedAt: new Date() },
          });
        await tx
          .insert(appSettingsTable)
          .values({ key: AUTO_GENERATION, value: LIBRARY_SYNC_GENERATION })
          .onConflictDoUpdate({
            target: appSettingsTable.key,
            set: { value: LIBRARY_SYNC_GENERATION, updatedAt: new Date() },
          });
      }
      await tx
        .insert(appSettingsTable)
        .values({ key: AUTO_SETTING, value: String(enabled) })
        .onConflictDoUpdate({
          target: appSettingsTable.key,
          set: { value: String(enabled), updatedAt: new Date() },
        });
    });
    // The setting is written directly so it can share the admission lock and
    // transaction with the watermark. Drop SettingsService's read cache only
    // after the commit is visible.
    settingsService.clearCache();
  }
  private async handle(job: DurableJob, context: DurableJobHandlerContext) {
    const payload = parsePayload(job.payload);
    if (!payload) throw new Error("Invalid library sync payload");
    const controller = new AbortController();
    const forward = () => controller.abort(context.signal.reason);
    context.signal.addEventListener("abort", forward, { once: true });
    if (context.signal.aborted) forward();
    this.controllers.set(job.id, controller);
    try {
      const rows = await db
        .select({
          id: videosTable.id,
          filePath: videosTable.filePath,
          durationSeconds: videosTable.durationSeconds,
        })
        .from(videosTable)
        .where(
          and(
            inArray(videosTable.id, payload.videoIds),
            eq(videosTable.isAvailable, true)
          )
        );
      const byId = new Map(rows.map((row) => [row.id, row]));
      let state = checkpointForCurrentGeneration(payload, job.checkpoint);
      await context.checkpoint({
        stage: "scanning",
        completedUnits: state.progress.processed,
        totalUnits: state.progress.total,
        data: state as unknown as Record<string, unknown>,
      });
      let ti = state.taskIndex;
      while (ti < payload.tasks.length) {
        const task = payload.tasks[ti]!;
        const start = ti === state.taskIndex ? state.videoIndex : 0;
        const completed =
          task === "perceptual" && !this.perceptualEnabled
            ? new Set<number>()
            : await this.processed(task, rows);
        for (let vi = start; vi < payload.videoIds.length; vi++) {
          if (controller.signal.aborted) throw controller.signal.reason;
          const videoId = payload.videoIds[vi]!;
          state.progress.current = { task, videoId };
          await context.checkpoint({
            stage: "executing",
            completedUnits: state.progress.processed,
            totalUnits: state.progress.total,
            data: state as unknown as Record<string, unknown>,
          });
          let item: LibrarySyncRecentItem;
          if (!byId.has(videoId) || completed.has(videoId))
            item = {
              task,
              videoId,
              status: "skipped",
              result: null,
              error: null,
            };
          else
            try {
              const result = await this.process(
                task,
                videoId,
                controller.signal
              );
              item = {
                task,
                videoId,
                status: "completed",
                result,
                error: null,
              };
            } catch (error) {
              if (controller.signal.aborted) throw error;
              const code =
                typeof error === "object" &&
                error !== null &&
                typeof (error as { code?: unknown }).code === "string"
                  ? String((error as { code: string }).code)
                  : "";
              const reportFailure = (failure: unknown) => {
                const context = {
                  source: "library_sync_item",
                  jobId: job.id,
                  videoId,
                  task,
                };
                logger.error(
                  { error: failure, ...context },
                  "Library sync item failed"
                );
                captureTelemetryException(failure, context);
              };
              if (
                !(
                  task === "perceptual" &&
                  (code === "COPY_CACHE_CORRUPT" ||
                    code === COPY_ENGINE_NOT_READY_CODE)
                )
              ) {
                reportFailure(error);
              }
              if (task === "perceptual" && code === "COPY_CACHE_CORRUPT") {
                try {
                  const result = await this.process(
                    task,
                    videoId,
                    controller.signal
                  );
                  item = {
                    task,
                    videoId,
                    status: "completed",
                    result,
                    error: null,
                  };
                } catch (retryError) {
                  if (controller.signal.aborted) throw retryError;
                  reportFailure(retryError);
                  throw retryError;
                }
              } else if (
                task === "perceptual" &&
                new Set([
                  "COPY_MODEL_MISSING",
                  "COPY_MODEL_INVALID",
                  "COPY_GPU_UNAVAILABLE",
                  "COPY_GPU_UNVERIFIED",
                  "COPY_PRECISION_INVALID",
                  "COPY_CACHE_FULL",
                  "ENGINE_UNAVAILABLE",
                ]).has(code)
              ) {
                throw error;
              } else {
                item = {
                  task,
                  videoId,
                  status: "failed",
                  result: null,
                  error:
                    task === "perceptual" &&
                    publicError("failed", { code })?.code !==
                      "LIBRARY_SYNC_FAILED"
                      ? publicError("failed", { code })
                      : {
                          code:
                            task === "perceptual"
                              ? "PERCEPTUAL_SYNC_FAILED"
                              : task === "faces"
                                ? "FACE_SYNC_FAILED"
                                : "STORYBOARD_SYNC_FAILED",
                          message:
                            task === "perceptual"
                              ? "Perceptual analysis failed"
                              : task === "faces"
                                ? "Face analysis failed"
                                : "Storyboard generation failed",
                        },
                };
              }
            }
          const progress = state.progress.byTask[task];
          progress.processed++;
          progress[item.status]++;
          progress.pending = Math.max(0, progress.total - progress.processed);
          state.progress.processed++;
          state.progress[item.status]++;
          state.progress.pending = Math.max(
            0,
            state.progress.total - state.progress.processed
          );
          state.progress.current = null;
          state.recentItems = [item, ...state.recentItems].slice(0, 50);
          state = {
            ...state,
            taskIndex: vi + 1 >= payload.videoIds.length ? ti + 1 : ti,
            videoIndex: vi + 1 >= payload.videoIds.length ? 0 : vi + 1,
          };
          await context.checkpoint({
            stage: "executing",
            completedUnits: state.progress.processed,
            totalUnits: state.progress.total,
            data: state as unknown as Record<string, unknown>,
          });
        }
        if (
          task === "perceptual" &&
          state.resumeTaskIndex !== undefined
        ) {
          const {
            resumeTaskIndex,
            resumeVideoIndex = 0,
            ...completedMigration
          } = state;
          state = {
            ...completedMigration,
            taskIndex: resumeTaskIndex,
            videoIndex: resumeVideoIndex,
          };
          await context.checkpoint({
            stage: "executing",
            completedUnits: state.progress.processed,
            totalUnits: state.progress.total,
            data: state as unknown as Record<string, unknown>,
          });
          ti = state.taskIndex;
          continue;
        }
        ti++;
      }
    } finally {
      context.signal.removeEventListener("abort", forward);
      this.controllers.delete(job.id);
    }
  }
  private processed(task: LibrarySyncTask, videos: Video[]) {
    const ids = videos.map((v) => v.id);
    return task === "perceptual"
      ? this.adapters.perceptual.processedIds(videos)
      : task === "faces"
        ? this.adapters.faces.processedIds(ids)
        : this.adapters.storyboards.processedIds(ids);
  }
  private async process(
    task: LibrarySyncTask,
    id: number,
    signal: AbortSignal
  ): Promise<Record<string, unknown>> {
    if (task === "perceptual") {
      assertCopyEngineReady(this.perceptualEnabled);
      const r = await this.adapters.perceptual.process(id, signal);
      return {
        compared_videos: r.compared_videos,
        ...(r.retrieval_references === undefined
          ? {}
          : { retrieval_references: r.retrieval_references }),
        ...(r.retrieval_candidates === undefined
          ? {}
          : { retrieval_candidates: r.retrieval_candidates }),
        ...(r.retrieval_truncated === undefined
          ? {}
          : { retrieval_truncated: r.retrieval_truncated }),
        match_count: r.match_count,
        truncated_matches: r.truncated_matches,
      };
    }
    if (task === "faces") return this.adapters.faces.process(id, signal);
    return this.adapters.storyboards.process(id, signal);
  }

  private get perceptualEnabled(): boolean {
    return this.options.perceptualEnabled ?? env.PERCEPTUAL_DUPLICATES_ENABLED;
  }
}

let singleton: LibrarySyncRuntime | null = null;
export function getLibrarySyncRuntime() {
  singleton ??= new LibrarySyncRuntime();
  return singleton;
}
export function enqueueNewVideo(videoId: number) {
  return getLibrarySyncRuntime().enqueueNewVideo(videoId);
}
export async function isLibrarySyncSchemaReady() {
  try {
    await db.execute(
      sql`SELECT id, kind, payload, checkpoint FROM ${durableJobsTable} LIMIT 0`
    );
    return true;
  } catch {
    return false;
  }
}
