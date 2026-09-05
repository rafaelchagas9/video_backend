import { SYSTEM_BOOKMARK_CATEGORY_KEYS } from "@/modules/bookmarks/bookmark-categories.constants";
import {
  getDemoSqlite,
  initializeDemoDatabase,
  withDemoTransaction,
} from "@/database/demo/client";
import { demoContentAnalysisScenarioForSource } from "@/database/demo/scenarios";
import { ForbiddenError, NotFoundError } from "@/utils/errors";
import { buildDemoContentAnalysisFixture } from "./content-analysis.demo.fixtures";
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
const EVENT_RESOURCE_KIND = "content-analysis-event";
const DEMO_SEED_TIMESTAMP = new Date("2026-01-01T00:00:00.000Z");
const DEMO_REVISIONS: ContentAnalysisRevisions = {
  analyzerRevision: "demo-nudity-v1",
  modelRevision: "demo-synthetic-findings-v1",
  taxonomyRevision: "nudenet-selected-11-v1",
  configRevision: "demo-deterministic-v2",
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

function unpublishPreviousRuns(
  runs: ContentAnalysisRun[],
  videoId: number,
  userId: number,
  timestamp: Date
): void {
  const previousRuns = runs.filter(
    (run) =>
      run.videoId === videoId &&
      run.userId === userId &&
      run.kind === "nudity" &&
      run.isPublished
  );
  const previousRunIds = previousRuns.map((run) => run.id);
  if (previousRunIds.length === 0) return;

  const placeholders = previousRunIds.map(() => "?").join(",");
  getDemoSqlite().run(
    `DELETE FROM demo_bookmarks
     WHERE analysis_run_id IN (${placeholders})
       AND origin='automatic'
       AND user_modified_at IS NULL`,
    previousRunIds
  );
  const storedEvents = getDemoSqlite()
    .query<
      { id: string; payload_json: string },
      [string]
    >("SELECT id,payload_json FROM demo_resources WHERE kind=?")
    .all(EVENT_RESOURCE_KIND);
  for (const storedEvent of storedEvents) {
    const event = JSON.parse(storedEvent.payload_json) as {
      runId: number;
      isPublished: boolean;
    };
    if (!previousRunIds.includes(event.runId)) continue;
    getDemoSqlite().run(
      "UPDATE demo_resources SET payload_json=?,updated_at=? WHERE kind=? AND id=?",
      [
        JSON.stringify({ ...event, isPublished: false }),
        timestamp.toISOString(),
        EVENT_RESOURCE_KIND,
        storedEvent.id,
      ]
    );
  }
  for (const run of previousRuns) {
    storeRun({
      ...run,
      isPublished: false,
      publishedAt: null,
      updatedAt: timestamp,
    });
  }
}

function publishBookmarks(
  run: ContentAnalysisRun,
  events: ReturnType<typeof buildDemoContentAnalysisFixture>["events"]
): void {
  const timestamp = run.completedAt!.toISOString();
  const categories = getDemoSqlite()
    .query<
      { id: number; key: string },
      []
    >("SELECT id,key FROM demo_bookmark_categories WHERE kind='system'")
    .all();
  const categoryIdByKey = new Map(
    categories.map((category) => [category.key, category.id])
  );
  const insertBookmark = getDemoSqlite().prepare(
    `INSERT INTO demo_bookmarks
      (video_id,user_id,timestamp_seconds,end_timestamp_seconds,peak_timestamp_seconds,origin,analysis_run_id,user_modified_at,name,description,created_at,updated_at)
     VALUES (?,?,?,?,?,'automatic',?,NULL,'Nudity episode',NULL,?,?)
     RETURNING id`
  );
  const insertAssignment = getDemoSqlite().prepare(
    `INSERT INTO demo_bookmark_category_assignments
      (bookmark_id,category_id,confidence,provider_label)
     VALUES (?,?,?,?)`
  );

  events.forEach((event, index) => {
    const bookmark = insertBookmark.get(
      run.videoId,
      run.userId,
      event.startSeconds,
      event.endSeconds,
      event.peakSeconds,
      run.id,
      timestamp,
      timestamp
    ) as { id: number } | null;
    if (!bookmark) {
      throw new Error("Failed to publish demo content analysis bookmark");
    }
    for (const summary of event.categorySummary) {
      const categoryId = categoryIdByKey.get(summary.category);
      if (!categoryId) {
        throw new Error(
          `Missing demo system bookmark category: ${summary.category}`
        );
      }
      insertAssignment.run(
        bookmark.id,
        categoryId,
        summary.maxScore,
        summary.providerLabel ?? null
      );
    }
    getDemoSqlite()
      .query(
        "INSERT INTO demo_resources (kind,id,payload_json,created_at,updated_at) VALUES (?,?,?,?,?)"
      )
      .run(
        EVENT_RESOURCE_KIND,
        `${run.id}:${index + 1}`,
        JSON.stringify({
          id: index + 1,
          runId: run.id,
          ...event,
          publishedBookmarkId: bookmark.id,
          isPublished: true,
          createdAt: timestamp,
        }),
        timestamp,
        timestamp
      );
  });
}

function materializeDemoContentAnalysis(
  input: StartContentAnalysisInput,
  timestamp: Date
): StartContentAnalysisResult {
  const parsed = startContentAnalysisSchema.parse(input);
  initializeDemoDatabase();
  return withDemoTransaction(() => {
    const video = getDemoSqlite()
      .query<
        {
          id: number;
          source_video_id: number | null;
          duration_seconds: number | null;
        },
        [number]
      >(
        "SELECT id,source_video_id,duration_seconds FROM demo_videos WHERE id=? LIMIT 1"
      )
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
    const fixture = buildDemoContentAnalysisFixture({
      scenario: demoContentAnalysisScenarioForSource(
        video.source_video_id ?? video.id
      ),
      durationSeconds: video.duration_seconds,
      profile: parsed.profile,
      requestedCategories,
      generationKey: semanticGenerationKey,
    });
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
      sampledFrames: fixture.sampledFrames,
      positiveFrames: fixture.positiveFrames,
      sourceFingerprint,
      ...DEMO_REVISIONS,
      idempotencyKey: parsed.idempotencyKey ?? null,
      requestDigest,
      semanticGenerationKey,
      resultEventCount: fixture.events.length,
      resultBookmarkCount: fixture.events.length,
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
    unpublishPreviousRuns(runs, parsed.videoId, parsed.userId, timestamp);
    storeRun(run);
    publishBookmarks(run, fixture.events);
    return { run, reused: false };
  });
}

/**
 * Populate the initial demo catalog through the same materialization path used
 * by request-driven analysis. The fixed timestamp keeps baseline generation
 * deterministic and makes a restored demo immediately useful for UI testing.
 */
export function prepopulateDemoContentAnalysis(): void {
  initializeDemoDatabase();
  const videoIds = getDemoSqlite()
    .query<{ id: number }, []>(
      "SELECT id FROM demo_videos WHERE id BETWEEN 1 AND 5 ORDER BY id"
    )
    .all()
    .map(({ id }) => id);

  for (const videoId of videoIds) {
    materializeDemoContentAnalysis(
      {
        videoId,
        userId: 1,
        profile: "balanced",
        categories: [...SYSTEM_BOOKMARK_CATEGORY_KEYS],
      },
      DEMO_SEED_TIMESTAMP
    );
  }
}

export class DemoContentAnalysisService {
  async start(
    input: StartContentAnalysisInput
  ): Promise<StartContentAnalysisResult> {
    return materializeDemoContentAnalysis(input, new Date());
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
