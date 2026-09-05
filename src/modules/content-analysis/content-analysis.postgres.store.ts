import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import {
  bookmarkCategoriesTable,
  bookmarkCategoryAssignmentsTable,
  bookmarksTable,
  contentAnalysisEventsTable,
  contentAnalysisObservationChunksTable,
  contentAnalysisRunsTable,
  durableJobsTable,
} from "@/database/schema";
import {
  ContentAnalysisIdempotencyConflictError,
  ContentAnalysisSourceChangedError,
  type ContentAnalysisRunStore,
} from "./content-analysis.store";
import { contentAnalysisCheckpointSchema } from "./content-analysis.schemas";
import type {
  ContentAnalysisEvent,
  ContentAnalysisEventDraft,
  ContentAnalysisIntent,
  ContentAnalysisLease,
  ContentAnalysisObservationChunk,
  ContentAnalysisProgress,
  ContentAnalysisRun,
  ContentAnalysisVideoSource,
} from "./content-analysis.types";
import {
  assertContentAnalysisProgress,
  assertContentAnalysisObservationChunk,
  CONTENT_ANALYSIS_ACTIVE_PHASE_ORDER,
} from "./content-analysis.validation";
import { sourceMatchesRun } from "./content-analysis.source";

type RunRow = typeof contentAnalysisRunsTable.$inferSelect;
type ApplicationDatabase = typeof import("@/config/drizzle").db;

export class PostgresContentAnalysisRunStore implements ContentAnalysisRunStore {
  constructor(private readonly database: ApplicationDatabase) {}

  async enqueue(
    intent: ContentAnalysisIntent
  ): Promise<{ run: ContentAnalysisRun; reused: boolean }> {
    return this.database.transaction(async (tx) => {
      if (intent.idempotencyKey) {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`content-analysis:idempotency:${intent.userId}:${intent.idempotencyKey}`}, 0))`
        );
        const [existing] = await tx
          .select()
          .from(contentAnalysisRunsTable)
          .where(
            and(
              eq(contentAnalysisRunsTable.userId, intent.userId),
              eq(contentAnalysisRunsTable.idempotencyKey, intent.idempotencyKey)
            )
          )
          .limit(1)
          .for("update");
        if (existing) {
          if (existing.requestDigest !== intent.requestDigest) {
            throw new ContentAnalysisIdempotencyConflictError();
          }
          return { run: this.mapRun(existing), reused: true };
        }
      }

      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`content-analysis:semantic:${intent.semanticGenerationKey}`}, 0))`
      );
      const equivalent = await tx
        .select()
        .from(contentAnalysisRunsTable)
        .where(
          and(
            eq(
              contentAnalysisRunsTable.semanticGenerationKey,
              intent.semanticGenerationKey
            ),
            inArray(contentAnalysisRunsTable.status, [
              "queued",
              "running",
              "retry_wait",
              "completed",
            ])
          )
        )
        .orderBy(desc(contentAnalysisRunsTable.id))
        .for("update");
      const active = equivalent.find((run) => run.status !== "completed");
      if (active) return { run: this.mapRun(active), reused: true };
      if (!intent.force && equivalent[0]) {
        return { run: this.mapRun(equivalent[0]), reused: true };
      }

      const [durableJob] = await tx
        .insert(durableJobsTable)
        .values({ kind: "vision.content-analysis", payload: { runId: 0 } })
        .returning({ id: durableJobsTable.id });
      if (!durableJob) throw new Error("Failed to create content analysis job");
      const [run] = await tx
        .insert(contentAnalysisRunsTable)
        .values({
          durableJobId: durableJob.id,
          videoId: intent.videoId,
          userId: intent.userId,
          kind: intent.kind,
          profile: intent.profile,
          requestedCategories: intent.requestedCategories,
          sourceDurationSeconds: intent.sourceDurationSeconds,
          sourceFingerprint: intent.sourceFingerprint,
          analyzerRevision: intent.analyzerRevision,
          modelRevision: intent.modelRevision,
          taxonomyRevision: intent.taxonomyRevision,
          configRevision: intent.configRevision,
          idempotencyKey: intent.idempotencyKey,
          requestDigest: intent.requestDigest,
          semanticGenerationKey: intent.semanticGenerationKey,
        })
        .returning();
      if (!run) throw new Error("Failed to create content analysis run");
      await tx
        .update(durableJobsTable)
        .set({ payload: { runId: run.id } })
        .where(eq(durableJobsTable.id, durableJob.id));
      return { run: this.mapRun(run), reused: false };
    });
  }

  async findById(runId: number): Promise<ContentAnalysisRun | null> {
    const [run] = await this.database
      .select()
      .from(contentAnalysisRunsTable)
      .where(eq(contentAnalysisRunsTable.id, runId))
      .limit(1);
    return run ? this.mapRun(run) : null;
  }

  async findByDurableJobId(
    durableJobId: number
  ): Promise<ContentAnalysisRun | null> {
    const [run] = await this.database
      .select()
      .from(contentAnalysisRunsTable)
      .where(eq(contentAnalysisRunsTable.durableJobId, durableJobId))
      .limit(1);
    return run ? this.mapRun(run) : null;
  }

  async stageObservationChunk(
    runId: number,
    lease: ContentAnalysisLease,
    chunk: ContentAnalysisObservationChunk
  ): Promise<boolean> {
    return this.database.transaction(async (tx) => {
      const [owned] = await tx
        .select({ run: contentAnalysisRunsTable })
        .from(contentAnalysisRunsTable)
        .innerJoin(
          durableJobsTable,
          eq(contentAnalysisRunsTable.durableJobId, durableJobsTable.id)
        )
        .where(
          and(
            eq(contentAnalysisRunsTable.id, runId),
            eq(contentAnalysisRunsTable.durableJobId, lease.durableJobId),
            eq(durableJobsTable.status, "running"),
            eq(durableJobsTable.leaseToken, lease.leaseToken),
            sql`${durableJobsTable.leaseExpiresAt} > clock_timestamp()`
          )
        )
        .limit(1)
        .for("update");
      if (!owned) return false;
      assertContentAnalysisObservationChunk(chunk, this.mapRun(owned.run));

      await tx
        .insert(contentAnalysisObservationChunksTable)
        .values({
          runId,
          phase: chunk.phase,
          chunkIndex: chunk.chunkIndex,
          startSeconds: chunk.startSeconds,
          endSeconds: chunk.endSeconds,
          sampledFrames: chunk.sampledFrames,
          positiveFrames: chunk.positiveFrames,
          findings: chunk.findings,
        })
        .onConflictDoUpdate({
          target: [
            contentAnalysisObservationChunksTable.runId,
            contentAnalysisObservationChunksTable.phase,
            contentAnalysisObservationChunksTable.chunkIndex,
          ],
          set: {
            startSeconds: chunk.startSeconds,
            endSeconds: chunk.endSeconds,
            sampledFrames: chunk.sampledFrames,
            positiveFrames: chunk.positiveFrames,
            findings: chunk.findings,
            updatedAt: sql`clock_timestamp()`,
          },
        });
      return true;
    });
  }

  async listObservationChunks(
    runId: number
  ): Promise<ContentAnalysisObservationChunk[]> {
    const rows = await this.database
      .select()
      .from(contentAnalysisObservationChunksTable)
      .where(eq(contentAnalysisObservationChunksTable.runId, runId))
      .orderBy(
        asc(contentAnalysisObservationChunksTable.phase),
        asc(contentAnalysisObservationChunksTable.chunkIndex)
      );
    return rows
      .map((row) => ({
        phase: row.phase as ContentAnalysisObservationChunk["phase"],
        chunkIndex: row.chunkIndex,
        startSeconds: row.startSeconds,
        endSeconds: row.endSeconds,
        sampledFrames: row.sampledFrames,
        positiveFrames: row.positiveFrames,
        findings: row.findings as ContentAnalysisObservationChunk["findings"],
      }))
      .sort(
        (left, right) =>
          (left.phase === right.phase ? 0 : left.phase === "coarse" ? -1 : 1) ||
          left.chunkIndex - right.chunkIndex
      );
  }

  async updateProgress(
    runId: number,
    lease: ContentAnalysisLease,
    progress: ContentAnalysisProgress
  ): Promise<ContentAnalysisRun | null> {
    return this.database.transaction(async (tx) => {
      const [active] = await tx
        .select({ checkpoint: durableJobsTable.checkpoint })
        .from(durableJobsTable)
        .where(
          and(
            eq(durableJobsTable.id, lease.durableJobId),
            eq(durableJobsTable.status, "running"),
            eq(durableJobsTable.leaseToken, lease.leaseToken),
            sql`${durableJobsTable.leaseExpiresAt} > clock_timestamp()`
          )
        )
        .limit(1)
        .for("update");
      if (!active) return null;

      const [currentRun] = await tx
        .select()
        .from(contentAnalysisRunsTable)
        .where(
          and(
            eq(contentAnalysisRunsTable.id, runId),
            eq(contentAnalysisRunsTable.durableJobId, lease.durableJobId),
            inArray(contentAnalysisRunsTable.status, [
              "queued",
              "running",
              "retry_wait",
            ])
          )
        )
        .limit(1)
        .for("update");
      if (!currentRun) {
        throw new Error("Active content analysis run is missing at checkpoint");
      }

      const parsedCheckpoint = active.checkpoint
        ? contentAnalysisCheckpointSchema.parse(active.checkpoint).data
        : null;
      const currentPhase = CONTENT_ANALYSIS_ACTIVE_PHASE_ORDER.includes(
        currentRun.phase as (typeof CONTENT_ANALYSIS_ACTIVE_PHASE_ORDER)[number]
      )
        ? (currentRun.phase as ContentAnalysisProgress["phase"])
        : "extracting";
      assertContentAnalysisProgress(
        progress,
        currentRun.sourceDurationSeconds,
        parsedCheckpoint ?? {
          phase: currentPhase,
          scannedSeconds: currentRun.scannedSeconds,
          sampledFrames: currentRun.sampledFrames,
          positiveFrames: currentRun.positiveFrames,
        }
      );

      const checkpoint = contentAnalysisCheckpointSchema.parse({
        stage: progress.phase,
        completedUnits: progress.scannedSeconds,
        totalUnits: currentRun.sourceDurationSeconds,
        data: {
          version: 1,
          phase: progress.phase,
          scannedSeconds: progress.scannedSeconds,
          sampledFrames: progress.sampledFrames,
          positiveFrames: progress.positiveFrames,
          ...(progress.cursor ? { cursor: progress.cursor } : {}),
        },
      });
      const [checkpointed] = await tx
        .update(durableJobsTable)
        .set({ checkpoint, updatedAt: sql`clock_timestamp()` })
        .where(
          and(
            eq(durableJobsTable.id, lease.durableJobId),
            eq(durableJobsTable.status, "running"),
            eq(durableJobsTable.leaseToken, lease.leaseToken),
            sql`${durableJobsTable.leaseExpiresAt} > clock_timestamp()`
          )
        )
        .returning({ id: durableJobsTable.id });
      if (!checkpointed) return null;

      const [updatedRun] = await tx
        .update(contentAnalysisRunsTable)
        .set({
          status: "running",
          phase: progress.phase,
          scannedSeconds: progress.scannedSeconds,
          sampledFrames: progress.sampledFrames,
          positiveFrames: progress.positiveFrames,
          errorCode: null,
          errorMessage: null,
          startedAt: sql`coalesce(${contentAnalysisRunsTable.startedAt}, clock_timestamp())`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(contentAnalysisRunsTable.id, runId),
            eq(contentAnalysisRunsTable.durableJobId, lease.durableJobId)
          )
        )
        .returning();
      if (!updatedRun) {
        throw new Error("Content analysis run disappeared at checkpoint");
      }
      return this.mapRun(updatedRun);
    });
  }

  async recordError(
    runId: number,
    lease: ContentAnalysisLease,
    input: {
      status: "retry_wait" | "failed";
      code: string;
      message: string;
      retryCount: number;
      retryDelayMs: number;
    }
  ): Promise<ContentAnalysisRun | null> {
    return this.database.transaction(async (tx) => {
      const [transitioned] = await tx
        .update(durableJobsTable)
        .set(
          input.status === "retry_wait"
            ? {
                status: "retry_wait",
                retryCount: input.retryCount,
                nextAttemptAt: sql`clock_timestamp() + (${input.retryDelayMs} * interval '1 millisecond')`,
                lastError: { code: input.code, message: input.message },
                workerId: null,
                leaseToken: null,
                leaseExpiresAt: null,
                updatedAt: sql`clock_timestamp()`,
              }
            : {
                status: "failed",
                lastError: { code: input.code, message: input.message },
                workerId: null,
                leaseToken: null,
                leaseExpiresAt: null,
                nextAttemptAt: null,
                completedAt: sql`clock_timestamp()`,
                updatedAt: sql`clock_timestamp()`,
              }
        )
        .where(
          and(
            eq(durableJobsTable.id, lease.durableJobId),
            eq(durableJobsTable.status, "running"),
            eq(durableJobsTable.leaseToken, lease.leaseToken),
            sql`${durableJobsTable.leaseExpiresAt} > clock_timestamp()`
          )
        )
        .returning({ id: durableJobsTable.id });
      if (!transitioned) return null;
      const [run] = await tx
        .update(contentAnalysisRunsTable)
        .set({
          status: input.status,
          phase:
            input.status === "failed"
              ? "failed"
              : sql`${contentAnalysisRunsTable.phase}`,
          errorCode: input.code,
          errorMessage: input.message,
          retryCount: input.retryCount,
          completedAt:
            input.status === "failed" ? sql`clock_timestamp()` : null,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(contentAnalysisRunsTable.id, runId),
            eq(contentAnalysisRunsTable.durableJobId, lease.durableJobId),
            inArray(contentAnalysisRunsTable.status, ["running", "retry_wait"])
          )
        )
        .returning();
      if (!run) {
        throw new Error(
          "Active content analysis run is missing at error transition"
        );
      }
      return this.mapRun(run);
    });
  }

  async cancel(
    runId: number,
    userId: number
  ): Promise<ContentAnalysisRun | null> {
    return this.database.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(contentAnalysisRunsTable)
        .where(
          and(
            eq(contentAnalysisRunsTable.id, runId),
            eq(contentAnalysisRunsTable.userId, userId)
          )
        )
        .limit(1);
      if (!existing) return null;
      if (["completed", "failed", "cancelled"].includes(existing.status)) {
        return this.mapRun(existing);
      }
      const [cancelledJob] = await tx
        .update(durableJobsTable)
        .set({
          status: "cancelled",
          workerId: null,
          leaseToken: null,
          leaseExpiresAt: null,
          nextAttemptAt: null,
          cancelledAt: sql`clock_timestamp()`,
          completedAt: sql`clock_timestamp()`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(durableJobsTable.id, existing.durableJobId),
            inArray(durableJobsTable.status, [
              "queued",
              "running",
              "retry_wait",
            ])
          )
        )
        .returning({ id: durableJobsTable.id });
      if (!cancelledJob) {
        const [current] = await tx
          .select()
          .from(contentAnalysisRunsTable)
          .where(eq(contentAnalysisRunsTable.id, runId))
          .limit(1);
        return current ? this.mapRun(current) : null;
      }
      const [cancelled] = await tx
        .update(contentAnalysisRunsTable)
        .set({
          status: "cancelled",
          phase: "cancelled",
          cancelledAt: sql`clock_timestamp()`,
          completedAt: sql`clock_timestamp()`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(eq(contentAnalysisRunsTable.id, runId))
        .returning();
      return cancelled ? this.mapRun(cancelled) : null;
    });
  }

  async listEvents(runId: number): Promise<ContentAnalysisEvent[]> {
    const rows = await this.database
      .select()
      .from(contentAnalysisEventsTable)
      .where(eq(contentAnalysisEventsTable.runId, runId))
      .orderBy(
        contentAnalysisEventsTable.startSeconds,
        contentAnalysisEventsTable.id
      );
    return rows.map((row) => ({
      ...row,
      categorySummary:
        row.categorySummary as ContentAnalysisEvent["categorySummary"],
    }));
  }

  private mapRun(row: RunRow): ContentAnalysisRun {
    return {
      ...row,
      kind: row.kind as "nudity",
      profile: row.profile as ContentAnalysisRun["profile"],
      requestedCategories:
        row.requestedCategories as ContentAnalysisRun["requestedCategories"],
      status: row.status as ContentAnalysisRun["status"],
      phase: row.phase as ContentAnalysisRun["phase"],
    };
  }

  publish(input: {
    runId: number;
    lease: ContentAnalysisLease;
    source: ContentAnalysisVideoSource;
    events: ContentAnalysisEventDraft[];
  }): Promise<ContentAnalysisRun | null> {
    return this.database.transaction(async (tx) => {
      const [acknowledged] = await tx
        .update(durableJobsTable)
        .set({
          status: "completed",
          workerId: null,
          leaseToken: null,
          leaseExpiresAt: null,
          nextAttemptAt: null,
          completedAt: sql`clock_timestamp()`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(durableJobsTable.id, input.lease.durableJobId),
            eq(durableJobsTable.status, "running"),
            eq(durableJobsTable.leaseToken, input.lease.leaseToken),
            sql`${durableJobsTable.leaseExpiresAt} > clock_timestamp()`
          )
        )
        .returning({ id: durableJobsTable.id });
      if (!acknowledged) return null;

      const [run] = await tx
        .select()
        .from(contentAnalysisRunsTable)
        .where(
          and(
            eq(contentAnalysisRunsTable.id, input.runId),
            eq(contentAnalysisRunsTable.durableJobId, input.lease.durableJobId),
            eq(contentAnalysisRunsTable.status, "running")
          )
        )
        .limit(1)
        .for("update");
      if (!run) {
        throw new Error(
          "Active content analysis run is missing at publication"
        );
      }
      if (
        input.source.id !== run.videoId ||
        !sourceMatchesRun(input.source, run)
      ) {
        throw new ContentAnalysisSourceChangedError();
      }

      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`content-analysis:publication:${run.videoId}:${run.userId}:${run.kind}`}, 0))`
      );

      const categoryKeys = [
        ...new Set(
          input.events.flatMap((event) =>
            event.categorySummary.map((summary) => summary.category)
          )
        ),
      ];
      const categories =
        categoryKeys.length === 0
          ? []
          : await tx
              .select({
                id: bookmarkCategoriesTable.id,
                key: bookmarkCategoriesTable.key,
              })
              .from(bookmarkCategoriesTable)
              .where(
                and(
                  eq(bookmarkCategoriesTable.kind, "system"),
                  inArray(bookmarkCategoriesTable.key, categoryKeys)
                )
              );
      if (categories.length !== categoryKeys.length) {
        throw new Error(
          "Content analysis system category catalog is incomplete"
        );
      }
      const categoryIdByKey = new Map(
        categories.map((category) => [category.key, category.id])
      );

      const oldPublishedRuns = await tx
        .select({ id: contentAnalysisRunsTable.id })
        .from(contentAnalysisRunsTable)
        .where(
          and(
            eq(contentAnalysisRunsTable.videoId, run.videoId),
            eq(contentAnalysisRunsTable.userId, run.userId),
            eq(contentAnalysisRunsTable.kind, run.kind),
            eq(contentAnalysisRunsTable.isPublished, true),
            ne(contentAnalysisRunsTable.id, run.id)
          )
        )
        .for("update");
      const oldRunIds = oldPublishedRuns.map(({ id }) => id);
      if (oldRunIds.length > 0) {
        await tx
          .update(contentAnalysisEventsTable)
          .set({ isPublished: false })
          .where(inArray(contentAnalysisEventsTable.runId, oldRunIds));
        await tx
          .update(contentAnalysisRunsTable)
          .set({ isPublished: false, publishedAt: null })
          .where(inArray(contentAnalysisRunsTable.id, oldRunIds));
      }

      await tx.execute(sql`
        DELETE FROM ${bookmarksTable} AS bookmark
        USING ${contentAnalysisRunsTable} AS old_run
        WHERE bookmark.analysis_run_id = old_run.id
          AND old_run.video_id = ${run.videoId}
          AND old_run.user_id = ${run.userId}
          AND old_run.kind = ${run.kind}
          AND old_run.id <> ${run.id}
          AND bookmark.origin = 'automatic'
          AND bookmark.user_modified_at IS NULL
      `);

      for (const event of input.events) {
        const [bookmark] = await tx
          .insert(bookmarksTable)
          .values({
            videoId: run.videoId,
            userId: run.userId,
            timestampSeconds: event.startSeconds,
            peakTimestampSeconds: event.peakSeconds,
            endTimestampSeconds: event.endSeconds,
            origin: "automatic",
            analysisRunId: run.id,
            name: "Nudity episode",
            description: null,
          })
          .returning({ id: bookmarksTable.id });
        if (!bookmark) {
          throw new Error("Failed to publish content analysis bookmark");
        }

        const [persistedEvent] = await tx
          .insert(contentAnalysisEventsTable)
          .values({
            runId: run.id,
            generationKey: event.generationKey,
            startSeconds: event.startSeconds,
            peakSeconds: event.peakSeconds,
            endSeconds: event.endSeconds,
            categorySummary: event.categorySummary,
            publishedBookmarkId: bookmark.id,
            isPublished: true,
          })
          .returning({ id: contentAnalysisEventsTable.id });
        if (!persistedEvent) {
          throw new Error("Failed to publish content analysis event");
        }

        await tx.insert(bookmarkCategoryAssignmentsTable).values(
          event.categorySummary.map((summary) => {
            const categoryId = categoryIdByKey.get(summary.category);
            if (!categoryId) {
              throw new Error(
                `Missing system bookmark category: ${summary.category}`
              );
            }
            return {
              bookmarkId: bookmark.id,
              categoryId,
              confidence: summary.maxScore,
              providerLabel: summary.providerLabel ?? null,
            };
          })
        );
      }

      const [published] = await tx
        .update(contentAnalysisRunsTable)
        .set({
          status: "completed",
          phase: "completed",
          scannedSeconds: run.sourceDurationSeconds,
          resultEventCount: input.events.length,
          resultBookmarkCount: input.events.length,
          errorCode: null,
          errorMessage: null,
          isPublished: true,
          publishedAt: sql`clock_timestamp()`,
          completedAt: sql`clock_timestamp()`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(contentAnalysisRunsTable.id, run.id),
            eq(contentAnalysisRunsTable.durableJobId, input.lease.durableJobId),
            eq(contentAnalysisRunsTable.status, "running")
          )
        )
        .returning();
      if (!published) {
        throw new Error("Failed to publish content analysis run");
      }
      return this.mapRun(published);
    });
  }
}
