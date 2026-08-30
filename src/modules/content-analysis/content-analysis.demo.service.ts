import { SYSTEM_BOOKMARK_CATEGORY_KEYS } from "@/modules/bookmarks/bookmark-categories.constants";
import {
  getDemoSqlite,
  initializeDemoDatabase,
  withDemoTransaction,
} from "@/database/demo";
import { ForbiddenError, NotFoundError } from "@/utils/errors";
import { startContentAnalysisSchema } from "./content-analysis.schemas";
import { ContentAnalysisIdempotencyConflictError } from "./content-analysis.store";
import {
  contentAnalysisRequestDigest,
  contentAnalysisSemanticKey,
} from "./content-analysis.source";
import type {
  ContentAnalysisRevisions,
  ContentAnalysisRun,
  StartContentAnalysisInput,
  StartContentAnalysisResult,
} from "./content-analysis.types";

const RESOURCE_KIND = "content-analysis-run";
const DEMO_REVISIONS: ContentAnalysisRevisions = {
  analyzerRevision: "demo-nudity-v1",
  modelRevision: "demo-no-inference",
  taxonomyRevision: "nudenet-selected-11-v1",
  configRevision: "demo-deterministic-v1",
};

type StoredRun = Omit<
  ContentAnalysisRun,
  | "publishedAt"
  | "startedAt"
  | "completedAt"
  | "cancelledAt"
  | "createdAt"
  | "updatedAt"
> & {
  publishedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
};

function restoreRun(run: StoredRun): ContentAnalysisRun {
  return {
    ...run,
    publishedAt: run.publishedAt ? new Date(run.publishedAt) : null,
    startedAt: run.startedAt ? new Date(run.startedAt) : null,
    completedAt: run.completedAt ? new Date(run.completedAt) : null,
    cancelledAt: run.cancelledAt ? new Date(run.cancelledAt) : null,
    createdAt: new Date(run.createdAt),
    updatedAt: new Date(run.updatedAt),
  };
}

function storeRun(run: ContentAnalysisRun): void {
  const timestamp = new Date().toISOString();
  getDemoSqlite()
    .query(
      "INSERT INTO demo_resources (kind,id,payload_json,created_at,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET payload_json=excluded.payload_json,updated_at=excluded.updated_at"
    )
    .run(
      RESOURCE_KIND,
      String(run.id),
      JSON.stringify(run),
      timestamp,
      timestamp
    );
}

function listRuns(): ContentAnalysisRun[] {
  initializeDemoDatabase();
  return getDemoSqlite()
    .query<{ payload_json: string }, [string]>(
      "SELECT payload_json FROM demo_resources WHERE kind=? ORDER BY CAST(id AS INTEGER)"
    )
    .all(RESOURCE_KIND)
    .map((row) => restoreRun(JSON.parse(row.payload_json) as StoredRun));
}

export class DemoContentAnalysisService {
  async start(
    input: StartContentAnalysisInput
  ): Promise<StartContentAnalysisResult> {
    const parsed = startContentAnalysisSchema.parse(input);
    initializeDemoDatabase();
    return withDemoTransaction(() => {
      const video = getDemoSqlite()
        .query<
          { id: number; duration_seconds: number | null },
          [number]
        >("SELECT id,duration_seconds FROM demo_videos WHERE id=? LIMIT 1")
        .get(parsed.videoId);
      if (!video) throw new NotFoundError("Video source is unavailable");
      if (!video.duration_seconds || video.duration_seconds <= 0) {
        throw new Error("Video source has no finite positive duration");
      }
      const requestedCategories = [
        ...(parsed.categories ?? SYSTEM_BOOKMARK_CATEGORY_KEYS),
      ].sort();
      const sourceFingerprint = `demo:${video.id}:${video.duration_seconds}`;
      const semanticGenerationKey = contentAnalysisSemanticKey({
        videoId: parsed.videoId,
        userId: parsed.userId,
        kind: "nudity",
        profile: parsed.profile,
        requestedCategories,
        sourceFingerprint,
        sourceDurationSeconds: video.duration_seconds,
        ...DEMO_REVISIONS,
      });
      const requestDigest = contentAnalysisRequestDigest({
        semanticGenerationKey,
        force: parsed.force,
      });
      const runs = listRuns();
      if (parsed.idempotencyKey) {
        const idempotent = runs.find(
          (run) =>
            run.userId === parsed.userId &&
            run.idempotencyKey === parsed.idempotencyKey
        );
        if (idempotent) {
          if (idempotent.requestDigest !== requestDigest) {
            throw new ContentAnalysisIdempotencyConflictError();
          }
          return { run: idempotent, reused: true };
        }
      }
      const equivalent = [...runs]
        .reverse()
        .find(
          (run) =>
            run.semanticGenerationKey === semanticGenerationKey &&
            run.status === "completed"
        );
      if (equivalent && !parsed.force) {
        return { run: equivalent, reused: true };
      }
      const id = runs.reduce((max, run) => Math.max(max, run.id), 0) + 1;
      const timestamp = new Date();
      const run: ContentAnalysisRun = {
        id,
        durableJobId: id,
        videoId: parsed.videoId,
        userId: parsed.userId,
        kind: "nudity",
        profile: parsed.profile,
        requestedCategories,
        status: "completed",
        phase: "completed",
        scannedSeconds: video.duration_seconds,
        sourceDurationSeconds: video.duration_seconds,
        sampledFrames: 0,
        positiveFrames: 0,
        sourceFingerprint,
        ...DEMO_REVISIONS,
        idempotencyKey: parsed.idempotencyKey ?? null,
        requestDigest,
        semanticGenerationKey,
        resultEventCount: 0,
        resultBookmarkCount: 0,
        errorCode: null,
        errorMessage: null,
        retryCount: 0,
        isPublished: true,
        publishedAt: timestamp,
        startedAt: timestamp,
        completedAt: timestamp,
        cancelledAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      storeRun(run);
      return { run, reused: false };
    });
  }

  async get(runId: number, userId: number): Promise<ContentAnalysisRun> {
    const run = listRuns().find((candidate) => candidate.id === runId);
    if (!run) {
      throw new NotFoundError(`Content analysis run not found: ${runId}`);
    }
    if (run.userId !== userId) {
      throw new ForbiddenError(
        "You do not have permission to inspect this analysis"
      );
    }
    return run;
  }

  async cancel(runId: number, userId: number): Promise<ContentAnalysisRun> {
    return this.get(runId, userId);
  }
}

export const demoContentAnalysisService = new DemoContentAnalysisService();
