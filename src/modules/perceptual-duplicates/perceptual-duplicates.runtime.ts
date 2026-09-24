import { createHash } from "node:crypto";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import { access, chmod, mkdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { z } from "zod";
import { db } from "@/config/drizzle";
import { env } from "@/config/env";
import { durableJobsTable, videosTable } from "@/database/schema";
import {
  DurableJobsService,
  DurableJobWorker,
  PostgresDurableJobStore,
  type DurableJob,
  type DurableJobErrorClassification,
  type DurableJobHandlerContext,
  type DurableJobStatus,
} from "@/modules/durable-jobs";
import { ConflictError, NotFoundError, ValidationError } from "@/utils/errors";
import { mediaWorkScheduler } from "@/utils/media-work-scheduler";
import {
  legacyPerceptualDuplicatesJobPayloadSchema,
  perceptualDuplicatesCheckpointSchema,
  perceptualDuplicatesJobPayloadSchema,
  type PerceptualDuplicatesCheckpoint,
  type PerceptualDuplicatesJobPayload,
} from "./perceptual-duplicates.schemas";
import { CATALOG_REVISION } from "./perceptual-catalog.schemas";
import {
  PerceptualDuplicatesRunnerError,
  PythonPerceptualDuplicatesRunner,
  type PerceptualDuplicatesEngineVideo,
  type PerceptualDuplicatesRunner,
} from "./perceptual-duplicates.runner";
import type {
  PerceptualDuplicatesJobView,
  PerceptualDuplicatesServiceContract,
  StartPerceptualDuplicatesInput,
} from "./perceptual-duplicates.types";
import {
  assertCopyEngineReady,
  COPY_ENGINE_NOT_READY_CODE,
  COPY_ENGINE_NOT_READY_REASON,
  CopyEngineNotReadyError,
} from "./perceptual-readiness";

export const PERCEPTUAL_DUPLICATES_JOB_KIND = "vision.perceptual-duplicates";
const ACTIVE_STATUSES = ["queued", "running", "retry_wait"] as const;

type DurableJobRecord = typeof durableJobsTable.$inferSelect;

interface SourceSnapshot {
  video: PerceptualDuplicatesEngineVideo;
  stats: BigIntStats;
}

class PerceptualDuplicatesDomainError extends Error {
  constructor(
    public readonly code: "SOURCE_UNAVAILABLE" | "SOURCE_CHANGED",
    message: string,
    public readonly retryable: boolean
  ) {
    super(message);
    this.name = "PerceptualDuplicatesDomainError";
  }
}

export class PerceptualDuplicatesUnavailableError extends Error {
  readonly code = "PERCEPTUAL_DUPLICATES_UNAVAILABLE";
  readonly statusCode = 503;

  constructor() {
    super("Perceptual duplicate comparison is unavailable");
    this.name = "PerceptualDuplicatesUnavailableError";
  }
}

function createDurableJobsService(): DurableJobsService {
  return new DurableJobsService(
    new PostgresDurableJobStore({
      async execute<Row extends Record<string, unknown>>(query: SQL) {
        return Array.from(await db.execute<Row>(query)) as Row[];
      },
    })
  );
}

function requestDigest(videoIds: readonly number[]): string {
  return `sha256:${createHash("sha256")
    .update(
      JSON.stringify({
        generation: CATALOG_REVISION,
        videoIds: [...videoIds].sort((a, b) => a - b),
      })
    )
    .digest("hex")}`;
}

function sameSource(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

type AnyPayload =
  | PerceptualDuplicatesJobPayload
  | z.infer<typeof legacyPerceptualDuplicatesJobPayloadSchema>;

function parsePayload(value: unknown): AnyPayload | null {
  const parsed = perceptualDuplicatesJobPayloadSchema
    .or(legacyPerceptualDuplicatesJobPayloadSchema)
    .safeParse(value);
  return parsed.success ? parsed.data : null;
}

function isCurrentPayload(
  payload: AnyPayload | null
): payload is PerceptualDuplicatesJobPayload {
  return (
    payload?.version === 2 && payload.generation === CATALOG_REVISION
  );
}

function parseCheckpoint(
  value: unknown
): PerceptualDuplicatesCheckpoint | null {
  const parsed = perceptualDuplicatesCheckpointSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function durableStatus(value: string): DurableJobStatus {
  if (
    value === "queued" ||
    value === "running" ||
    value === "retry_wait" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
  ) {
    return value;
  }
  throw new Error("Perceptual duplicate job has an invalid status");
}

function publicError(
  status: DurableJobStatus,
  value: unknown
): { code: string; message: string } | null {
  if (status !== "failed") return null;
  const code =
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).code === "string"
      ? String((value as Record<string, unknown>).code)
      : "PERCEPTUAL_DUPLICATES_FAILED";
  const messages: Record<string, string> = {
    ENGINE_UNAVAILABLE: "Perceptual duplicate engine is unavailable",
    ENGINE_FAILED: "Perceptual duplicate engine failed",
    ENGINE_TIMEOUT: "Perceptual duplicate comparison timed out",
    ENGINE_OUTPUT_TOO_LARGE:
      "Perceptual duplicate engine output exceeded the safe limit",
    ENGINE_INVALID_RESULT:
      "Perceptual duplicate engine returned an invalid result",
    COPY_MODEL_MISSING: "Perceptual duplicate model is unavailable",
    COPY_MODEL_INVALID: "Perceptual duplicate model is invalid",
    COPY_GPU_UNAVAILABLE: "Required GPU inference is unavailable",
    COPY_GPU_UNVERIFIED: "GPU inference could not be verified",
    COPY_PRECISION_INVALID: "GPU inference precision is invalid",
    COPY_SOURCE_CHANGED:
      "One or more selected videos changed during comparison",
    COPY_DECODE_FAILED: "One or more selected videos could not be decoded",
    COPY_CACHE_CORRUPT: "Perceptual duplicate cache is corrupt",
    COPY_CACHE_FULL: "Perceptual duplicate cache is full",
    COPY_ENGINE_NOT_READY: COPY_ENGINE_NOT_READY_REASON,
    COPY_ANALYSIS_FAILED: "Perceptual duplicate analysis failed",
    SOURCE_UNAVAILABLE: "One or more selected videos became unavailable",
    SOURCE_CHANGED: "One or more selected videos changed during comparison",
    JOB_RETRY_BUDGET_EXHAUSTED:
      "Perceptual duplicate comparison exhausted its retry budget",
    PERCEPTUAL_DUPLICATES_GENERATION_STALE:
      "This comparison belongs to an earlier engine revision; start a new comparison",
  };
  return {
    code: /^[A-Z0-9_]{1,64}$/.test(code)
      ? code
      : "PERCEPTUAL_DUPLICATES_FAILED",
    message: messages[code] ?? "Perceptual duplicate comparison failed",
  };
}

function mapJob(record: DurableJobRecord): PerceptualDuplicatesJobView | null {
  if (record.kind !== PERCEPTUAL_DUPLICATES_JOB_KIND) return null;
  const payload = parsePayload(record.payload);
  if (!payload) return null;
  const status = durableStatus(record.status);
  const checkpoint = parseCheckpoint(record.checkpoint);
  const publishedResult = checkpoint?.data?.result;
  const staleCompleted =
    status === "completed" &&
    (!isCurrentPayload(payload) || publishedResult?.revision !== CATALOG_REVISION);
  const visibleStatus = staleCompleted ? "failed" : status;
  const phase =
    staleCompleted
      ? "failed"
      : status === "queued"
      ? "queued"
      : status === "completed"
        ? "completed"
        : status === "failed"
          ? "failed"
          : status === "cancelled"
            ? "cancelled"
            : checkpoint?.stage === "preparing" ||
                checkpoint?.stage === "comparing"
              ? checkpoint.stage
              : "queued";
  return {
    id: record.id,
    userId: payload.userId,
    videoIds: payload.videoIds,
    status: visibleStatus,
    phase,
    completedUnits: checkpoint?.completedUnits ?? 0,
    totalUnits: checkpoint?.totalUnits ?? payload.videoIds.length,
    result:
      status === "completed" && !staleCompleted
        ? (publishedResult ?? null)
        : null,
    error: staleCompleted
      ? publicError("failed", {
          code: "PERCEPTUAL_DUPLICATES_GENERATION_STALE",
        })
      : publicError(status, record.lastError),
    retryCount: record.retryCount,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    cancelledAt: record.cancelledAt,
  };
}

export class PerceptualDuplicatesRuntime implements PerceptualDuplicatesServiceContract {
  private readonly durableJobs: DurableJobsService;
  private readonly worker: DurableJobWorker;
  private readonly activeControllers = new Map<number, AbortController>();

  constructor(
    private readonly runner: PerceptualDuplicatesRunner = new PythonPerceptualDuplicatesRunner(
      {
        pythonPath: env.PERCEPTUAL_DUPLICATES_PYTHON_PATH,
        moduleName: env.PERCEPTUAL_DUPLICATES_MODULE,
        workDir: env.PERCEPTUAL_DUPLICATES_WORK_DIR,
        cacheDir: env.PERCEPTUAL_DUPLICATES_CACHE_DIR,
        timeoutMs: env.PERCEPTUAL_DUPLICATES_TIMEOUT_MS,
        maxOutputBytes: env.PERCEPTUAL_DUPLICATES_MAX_OUTPUT_BYTES,
        environment: {
          FFMPEG_PATH: env.FFMPEG_PATH,
          VAAPI_DEVICE: env.VAAPI_DEVICE,
        },
      }
    ),
    private readonly options: { perceptualEnabled?: boolean } = {}
  ) {
    this.durableJobs = createDurableJobsService();
    this.worker = new DurableJobWorker(this.durableJobs, {
      workerId: `perceptual-duplicates-worker-${process.pid}`,
      leaseDurationMs: 60_000,
      heartbeatIntervalMs: 20_000,
      pollIntervalMs: 1_000,
      maxRetries: 2,
      retryDelayMs: (job) => Math.min(5 * 60_000, 30_000 * 2 ** job.retryCount),
      stopGracePeriodMs: 10_000,
      kinds: [PERCEPTUAL_DUPLICATES_JOB_KIND],
      handlers: {
        [PERCEPTUAL_DUPLICATES_JOB_KIND]: (job, context) =>
          this.handle(job, context),
      },
      classifyError: (error) => this.classifyError(error),
    });
  }

  async start(input: StartPerceptualDuplicatesInput): Promise<{
    job: PerceptualDuplicatesJobView;
    reused: boolean;
  }>;
  start(): Promise<void>;
  async start(
    input?: StartPerceptualDuplicatesInput
  ): Promise<{ job: PerceptualDuplicatesJobView; reused: boolean } | void> {
    if (!input) return this.worker.start();
    assertCopyEngineReady(this.perceptualEnabled);
    await this.assertEngineFilesAvailable();
    const videoIds = [...input.videoIds].sort((a, b) => a - b);
    const digest = requestDigest(videoIds);
    return db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`perceptual-duplicates:${input.userId}`}, 0))`
      );
      const active = await tx
        .select()
        .from(durableJobsTable)
        .where(
          and(
            eq(durableJobsTable.kind, PERCEPTUAL_DUPLICATES_JOB_KIND),
            inArray(durableJobsTable.status, [...ACTIVE_STATUSES]),
            sql`${durableJobsTable.payload}->>'userId' = ${String(input.userId)}`
          )
        )
        .orderBy(asc(durableJobsTable.createdAt));
      const equivalent = active.find(
        (candidate) => {
          const payload = parsePayload(candidate.payload);
          return isCurrentPayload(payload) && payload.requestDigest === digest;
        }
      );
      if (equivalent) {
        const job = mapJob(equivalent);
        if (!job)
          throw new Error("Equivalent perceptual duplicate job is invalid");
        return { job, reused: true };
      }
      if (active.length >= env.PERCEPTUAL_DUPLICATES_MAX_ACTIVE_JOBS) {
        throw new ConflictError(
          "The active perceptual duplicate comparison limit has been reached"
        );
      }
      const selected = await tx
        .select({
          id: videosTable.id,
          isAvailable: videosTable.isAvailable,
          durationSeconds: videosTable.durationSeconds,
        })
        .from(videosTable)
        .where(inArray(videosTable.id, videoIds));
      if (selected.length !== videoIds.length) {
        throw new NotFoundError("One or more selected videos were not found");
      }
      if (
        selected.some(
          (video) =>
            !video.isAvailable ||
            !Number.isFinite(video.durationSeconds) ||
            (video.durationSeconds ?? 0) < 5 ||
            (video.durationSeconds ?? 0) > 24 * 60 * 60
        )
      ) {
        throw new ValidationError(
          "All selected videos must be available and between 5 seconds and 24 hours"
        );
      }
      const totalDuration = selected.reduce(
        (sum, video) => sum + (video.durationSeconds ?? 0),
        0
      );
      if (totalDuration > 72 * 60 * 60) {
        throw new ValidationError(
          "The selected videos must total no more than 72 hours"
        );
      }
      const payload: PerceptualDuplicatesJobPayload = {
        version: 2,
        generation: CATALOG_REVISION,
        userId: input.userId,
        videoIds,
        requestDigest: digest,
      };
      const [inserted] = await tx
        .insert(durableJobsTable)
        .values({ kind: PERCEPTUAL_DUPLICATES_JOB_KIND, payload })
        .returning();
      if (!inserted)
        throw new Error("Failed to create perceptual duplicate job");
      const job = mapJob(inserted);
      if (!job) throw new Error("Created perceptual duplicate job is invalid");
      return { job, reused: false };
    });
  }

  stop(): Promise<void> {
    return this.worker.stop();
  }

  private async assertEngineFilesAvailable(): Promise<void> {
    const configuredModel = process.env.COPY_MODEL_PATH;
    const modelPath = configuredModel
      ? resolve(env.PERCEPTUAL_DUPLICATES_WORK_DIR, configuredModel)
      : resolve(
          env.PERCEPTUAL_DUPLICATES_WORK_DIR,
          "models/copies/sscd_disc_mixup.onnx"
        );
    const manifestPath = modelPath.replace(/\.[^./\\]+$/, ".json");
    try {
      await Promise.all([
        access(
          resolve(env.PERCEPTUAL_DUPLICATES_PYTHON_PATH),
          fsConstants.X_OK
        ),
        access(modelPath, fsConstants.R_OK),
        access(manifestPath, fsConstants.R_OK),
      ]);
    } catch {
      throw new PerceptualDuplicatesUnavailableError();
    }
  }

  async get(
    jobId: number,
    userId: number
  ): Promise<PerceptualDuplicatesJobView> {
    const record = await this.findOwnedRecord(jobId, userId);
    const job = record ? mapJob(record) : null;
    if (!job) throw new NotFoundError("Perceptual duplicate job not found");
    return job;
  }

  async cancel(
    jobId: number,
    userId: number
  ): Promise<PerceptualDuplicatesJobView> {
    const current = await this.get(jobId, userId);
    if (
      current.status === "completed" ||
      current.status === "failed" ||
      current.status === "cancelled"
    ) {
      return current;
    }
    await this.durableJobs.requestCancellation(jobId);
    this.activeControllers
      .get(jobId)
      ?.abort(
        new DOMException(
          "Perceptual duplicate comparison cancelled",
          "AbortError"
        )
      );
    return this.get(jobId, userId);
  }

  private async findOwnedRecord(
    jobId: number,
    userId: number
  ): Promise<DurableJobRecord | null> {
    const [record] = await db
      .select()
      .from(durableJobsTable)
      .where(
        and(
          eq(durableJobsTable.id, jobId),
          eq(durableJobsTable.kind, PERCEPTUAL_DUPLICATES_JOB_KIND),
          sql`${durableJobsTable.payload}->>'userId' = ${String(userId)}`
        )
      )
      .limit(1);
    return record ?? null;
  }

  private async loadSources(videoIds: number[]): Promise<SourceSnapshot[]> {
    const rows = await db
      .select({
        id: videosTable.id,
        filePath: videosTable.filePath,
        durationSeconds: videosTable.durationSeconds,
        isAvailable: videosTable.isAvailable,
      })
      .from(videosTable)
      .where(inArray(videosTable.id, videoIds));
    const byId = new Map(rows.map((row) => [row.id, row]));
    const snapshots: SourceSnapshot[] = [];
    for (const id of videoIds) {
      const row = byId.get(id);
      if (
        !row ||
        !row.isAvailable ||
        !Number.isFinite(row.durationSeconds) ||
        (row.durationSeconds ?? 0) < 5 ||
        (row.durationSeconds ?? 0) > 24 * 60 * 60
      ) {
        throw new PerceptualDuplicatesDomainError(
          "SOURCE_UNAVAILABLE",
          "A selected video is unavailable",
          true
        );
      }
      let stats: BigIntStats;
      try {
        stats = await stat(row.filePath, { bigint: true });
      } catch {
        throw new PerceptualDuplicatesDomainError(
          "SOURCE_UNAVAILABLE",
          "A selected video is unavailable",
          true
        );
      }
      if (!stats.isFile()) {
        throw new PerceptualDuplicatesDomainError(
          "SOURCE_UNAVAILABLE",
          "A selected video is unavailable",
          true
        );
      }
      snapshots.push({
        video: {
          id,
          path: row.filePath,
          duration_seconds: row.durationSeconds!,
        },
        stats,
      });
    }
    return snapshots;
  }

  private async assertSourcesUnchanged(
    snapshots: SourceSnapshot[]
  ): Promise<void> {
    const rows = await db
      .select({ id: videosTable.id, filePath: videosTable.filePath })
      .from(videosTable)
      .where(
        inArray(
          videosTable.id,
          snapshots.map(({ video }) => video.id)
        )
      );
    const paths = new Map(rows.map((row) => [row.id, row.filePath]));
    for (const snapshot of snapshots) {
      const currentPath = paths.get(snapshot.video.id);
      if (currentPath !== snapshot.video.path) {
        throw new PerceptualDuplicatesDomainError(
          "SOURCE_CHANGED",
          "A selected video changed during comparison",
          false
        );
      }
      try {
        const current = await stat(currentPath, { bigint: true });
        if (!sameSource(snapshot.stats, current)) {
          throw new PerceptualDuplicatesDomainError(
            "SOURCE_CHANGED",
            "A selected video changed during comparison",
            false
          );
        }
      } catch (error) {
        if (error instanceof PerceptualDuplicatesDomainError) throw error;
        throw new PerceptualDuplicatesDomainError(
          "SOURCE_CHANGED",
          "A selected video changed during comparison",
          false
        );
      }
    }
  }

  private async handle(
    job: DurableJob,
    context: DurableJobHandlerContext
  ): Promise<void> {
    const payload = parsePayload(job.payload);
    if (!payload) throw new Error("Invalid perceptual duplicate job payload");
    if (!isCurrentPayload(payload)) {
      throw Object.assign(
        new Error("Perceptual duplicate job generation is stale"),
        { code: "PERCEPTUAL_DUPLICATES_GENERATION_STALE" }
      );
    }
    assertCopyEngineReady(this.perceptualEnabled);
    const localController = new AbortController();
    this.activeControllers.set(job.id, localController);
    const signal = AbortSignal.any([context.signal, localController.signal]);
    try {
      await context.checkpoint({
        stage: "preparing",
        completedUnits: 0,
        totalUnits: payload.videoIds.length,
      });
      await mkdir(env.PERCEPTUAL_DUPLICATES_CACHE_DIR, {
        recursive: true,
        mode: 0o700,
      });
      await chmod(env.PERCEPTUAL_DUPLICATES_CACHE_DIR, 0o700);
      const { result, sources } = await mediaWorkScheduler.run(
        "background",
        async () => {
          const admittedSources = await this.loadSources(payload.videoIds);
          signal.throwIfAborted();
          await context.checkpoint({
            stage: "comparing",
            completedUnits: 0,
            totalUnits: payload.videoIds.length,
          });
          const admittedResult = await this.runner.run({
            videos: admittedSources.map(({ video }) => video),
            signal,
          });
          if (admittedResult.revision !== CATALOG_REVISION) {
            throw new PerceptualDuplicatesRunnerError(
              "ENGINE_INVALID_RESULT",
              "Perceptual duplicate engine returned an invalid result",
              false
            );
          }
          return { result: admittedResult, sources: admittedSources };
        },
        signal
      );
      signal.throwIfAborted();
      await this.assertSourcesUnchanged(sources);
      await context.checkpoint({
        stage: "completed",
        completedUnits: payload.videoIds.length,
        totalUnits: payload.videoIds.length,
        data: { result },
      });
    } catch (error) {
      if (localController.signal.aborted && !context.signal.aborted) return;
      throw error;
    } finally {
      if (this.activeControllers.get(job.id) === localController) {
        this.activeControllers.delete(job.id);
      }
    }
  }

  private classifyError(error: unknown): DurableJobErrorClassification {
    if (error instanceof CopyEngineNotReadyError) {
      return {
        retryable: false,
        error: {
          code: COPY_ENGINE_NOT_READY_CODE,
          message: COPY_ENGINE_NOT_READY_REASON,
        },
      };
    }
    if (
      typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code ===
        "PERCEPTUAL_DUPLICATES_GENERATION_STALE"
    ) {
      return {
        retryable: false,
        error: {
          code: "PERCEPTUAL_DUPLICATES_GENERATION_STALE",
          message: "Perceptual duplicate job generation is stale",
        },
      };
    }
    if (error instanceof PerceptualDuplicatesRunnerError) {
      return {
        retryable: error.retryable,
        error: { code: error.code, message: error.message },
      };
    }
    if (error instanceof PerceptualDuplicatesDomainError) {
      return {
        retryable: error.retryable,
        error: { code: error.code, message: error.message },
      };
    }
    return {
      retryable: false,
      error: {
        code: "PERCEPTUAL_DUPLICATES_FAILED",
        message: "Perceptual duplicate comparison failed",
      },
    };
  }

  private get perceptualEnabled(): boolean {
    return this.options.perceptualEnabled ?? env.PERCEPTUAL_DUPLICATES_ENABLED;
  }
}

let singleton: PerceptualDuplicatesRuntime | null = null;

export function getPerceptualDuplicatesRuntime(): PerceptualDuplicatesRuntime {
  singleton ??= new PerceptualDuplicatesRuntime();
  return singleton;
}

export async function stopPerceptualDuplicatesRuntime(): Promise<void> {
  await singleton?.stop();
}

export async function isPerceptualDuplicatesSchemaReady(): Promise<boolean> {
  try {
    await db.execute(sql`
      SELECT job.id, video.id
      FROM durable_jobs AS job
      CROSS JOIN videos AS video
      LIMIT 0
    `);
    return true;
  } catch {
    return false;
  }
}
