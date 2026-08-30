import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/database/schema";
import {
  PostgresContentAnalysisRunStore,
  type ContentAnalysisEventDraft,
  type ContentAnalysisIntent,
  type ContentAnalysisLease,
} from "@/modules/content-analysis";
import { startTestDatabase } from "../helpers/test-database";

type TestDatabase = Awaited<ReturnType<typeof startTestDatabase>>;

const migrations = [
  resolve(
    process.cwd(),
    "src/database/drizzle-migrations/0038_abandoned_magus.sql"
  ),
  resolve(
    process.cwd(),
    "src/database/drizzle-migrations/0039_freezing_daimon_hellstrom.sql"
  ),
  resolve(
    process.cwd(),
    "src/database/drizzle-migrations/0040_overrated_dreaming_celestial.sql"
  ),
];

const source = {
  id: 1,
  sourceFingerprint: "partial-sha256-v1:integration-video",
  durationSeconds: 120,
};

function intent(
  semanticSuffix: string,
  overrides: Partial<ContentAnalysisIntent> = {}
): ContentAnalysisIntent {
  return {
    videoId: source.id,
    userId: 1,
    kind: "nudity",
    profile: "balanced",
    requestedCategories: ["BUTTOCKS_EXPOSED"],
    sourceFingerprint: source.sourceFingerprint,
    sourceDurationSeconds: source.durationSeconds,
    analyzerRevision: "analyzer:v1",
    modelRevision: "model:v1",
    taxonomyRevision: "taxonomy:v1",
    configRevision: "config:v1",
    idempotencyKey: null,
    requestDigest: `request:${semanticSuffix}`,
    semanticGenerationKey: `semantic:${semanticSuffix}`,
    force: false,
    ...overrides,
  };
}

function event(
  generationKey: string,
  startSeconds = 10
): ContentAnalysisEventDraft {
  return {
    generationKey,
    startSeconds,
    peakSeconds: startSeconds + 1,
    endSeconds: startSeconds + 2,
    categorySummary: [
      {
        category: "BUTTOCKS_EXPOSED",
        count: 2,
        maxScore: 0.9,
        meanScore: 0.8,
        providerLabel: "BUTTOCKS_EXPOSED",
      },
    ],
  };
}

describe("PostgresContentAnalysisRunStore", () => {
  let container: TestDatabase;
  let client: ReturnType<typeof postgres>;
  let store: PostgresContentAnalysisRunStore;

  async function applyMigration(path: string): Promise<void> {
    const migration = await readFile(path, "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await client.unsafe(statement);
    }
  }

  async function claim(
    durableJobId: number,
    token: string
  ): Promise<ContentAnalysisLease> {
    await client`
      UPDATE durable_jobs
      SET status = 'running', worker_id = 'integration-worker',
          lease_token = ${token}, lease_expires_at = clock_timestamp() + interval '5 minutes',
          attempt = attempt + 1, started_at = coalesce(started_at, clock_timestamp()),
          heartbeat_at = clock_timestamp(), updated_at = clock_timestamp()
      WHERE id = ${durableJobId}
    `;
    return { durableJobId, leaseToken: token };
  }

  async function publish(
    run: Awaited<ReturnType<PostgresContentAnalysisRunStore["findById"]>> & {},
    events: ContentAnalysisEventDraft[],
    token: string
  ) {
    const lease = await claim(run.durableJobId, token);
    const started = await store.updateProgress(run.id, lease, {
      phase: "publishing",
      scannedSeconds: source.durationSeconds,
      sampledFrames: events.length,
      positiveFrames: events.length,
    });
    expect(started).not.toBeNull();
    return store.publish({ runId: run.id, lease, source, events });
  }

  beforeAll(async () => {
    container = await startTestDatabase();
    client = postgres(container.connectionString, { max: 12 });
    await client`CREATE TABLE users (id serial PRIMARY KEY)`;
    await client`CREATE TABLE videos (id serial PRIMARY KEY)`;
    await client`
      CREATE TABLE durable_jobs (
        id serial PRIMARY KEY,
        kind text NOT NULL,
        payload jsonb NOT NULL,
        status text DEFAULT 'queued' NOT NULL,
        attempt integer DEFAULT 0 NOT NULL,
        worker_id text,
        lease_token text,
        lease_expires_at timestamptz,
        checkpoint jsonb,
        retry_count integer DEFAULT 0 NOT NULL,
        next_attempt_at timestamptz,
        last_error jsonb,
        started_at timestamptz,
        heartbeat_at timestamptz,
        created_at timestamptz DEFAULT now() NOT NULL,
        updated_at timestamptz DEFAULT now() NOT NULL,
        completed_at timestamptz,
        cancelled_at timestamptz
      )
    `;
    await client`
      CREATE TABLE bookmarks (
        id serial PRIMARY KEY,
        video_id integer NOT NULL,
        user_id integer NOT NULL,
        timestamp_seconds real NOT NULL,
        name text NOT NULL,
        description text,
        created_at timestamp DEFAULT now() NOT NULL,
        updated_at timestamp DEFAULT now() NOT NULL
      )
    `;
    for (const migration of migrations) await applyMigration(migration);
    await client`INSERT INTO users (id) VALUES (1)`;
    await client`INSERT INTO videos (id) VALUES (1)`;

    const database = drizzle(client, { schema });
    store = new PostgresContentAnalysisRunStore(database);
  }, 120_000);

  beforeEach(async () => {
    await client`
      TRUNCATE content_analysis_events, bookmark_category_assignments,
               bookmarks, content_analysis_runs, durable_jobs
      RESTART IDENTITY CASCADE
    `;
  });

  afterAll(async () => {
    await client?.end({ timeout: 5 });
    await container?.stop();
  }, 30_000);

  it("serializes equivalent and idempotent concurrent enqueue requests", async () => {
    const equivalent = await Promise.all([
      store.enqueue(intent("semantic-race")),
      store.enqueue(intent("semantic-race")),
    ]);

    expect(new Set(equivalent.map(({ run }) => run.id)).size).toBe(1);
    expect(equivalent.filter(({ reused }) => !reused)).toHaveLength(1);
    expect(equivalent.filter(({ reused }) => reused)).toHaveLength(1);

    const idempotentIntent = intent("idempotent-race", {
      idempotencyKey: "integration-idempotency-key",
    });
    const idempotent = await Promise.all([
      store.enqueue(idempotentIntent),
      store.enqueue(idempotentIntent),
    ]);
    expect(new Set(idempotent.map(({ run }) => run.id)).size).toBe(1);
    expect(idempotent.filter(({ reused }) => !reused)).toHaveLength(1);
    expect(idempotent.filter(({ reused }) => reused)).toHaveLength(1);

    const [counts] = await client<Array<{ runs: number; jobs: number }>>`
      SELECT
        (SELECT count(*)::int FROM content_analysis_runs) AS runs,
        (SELECT count(*)::int FROM durable_jobs) AS jobs
    `;
    expect(counts).toEqual({ runs: 2, jobs: 2 });
  });

  it("rejects concurrent reuse of an idempotency key for a different request", async () => {
    const outcomes = await Promise.allSettled([
      store.enqueue(
        intent("idempotency-conflict-a", {
          idempotencyKey: "integration-conflict-key",
        })
      ),
      store.enqueue(
        intent("idempotency-conflict-b", {
          idempotencyKey: "integration-conflict-key",
        })
      ),
    ]);

    const fulfilled = outcomes.filter(
      (outcome) => outcome.status === "fulfilled"
    );
    const rejected = outcomes.filter(
      (outcome) => outcome.status === "rejected"
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    if (rejected[0]?.status !== "rejected") {
      throw new Error("Expected one idempotency conflict");
    }
    expect(rejected[0].reason).toBeInstanceOf(Error);
    expect((rejected[0].reason as Error).message).toBe(
      "Idempotency key belongs to a different analysis request"
    );

    const [counts] = await client<Array<{ runs: number; jobs: number }>>`
      SELECT
        (SELECT count(*)::int FROM content_analysis_runs) AS runs,
        (SELECT count(*)::int FROM durable_jobs) AS jobs
    `;
    expect(counts).toEqual({ runs: 1, jobs: 1 });
  });

  it("upserts media-free observation chunks only for the active lease", async () => {
    const queued = await store.enqueue(intent("observation-chunk"));
    const lease = await claim(queued.run.durableJobId, "observation-token");
    const chunk = {
      phase: "coarse" as const,
      chunkIndex: 0,
      startSeconds: 0,
      endSeconds: 120,
      sampledFrames: 60,
      positiveFrames: 1,
      findings: [
        {
          timestampSeconds: 12,
          category: "BUTTOCKS_EXPOSED" as const,
          score: 0.91,
          providerLabel: "BUTTOCKS_EXPOSED",
        },
      ],
    };

    expect(await store.stageObservationChunk(queued.run.id, lease, chunk)).toBe(
      true
    );
    expect(
      await store.stageObservationChunk(queued.run.id, lease, {
        ...chunk,
        sampledFrames: 61,
      })
    ).toBe(true);
    expect(await store.listObservationChunks(queued.run.id)).toEqual([
      { ...chunk, sampledFrames: 61 },
    ]);

    expect(
      await store.stageObservationChunk(
        queued.run.id,
        { ...lease, leaseToken: "stale-token" },
        chunk
      )
    ).toBe(false);
    const [stored] = await client<
      Array<{ findings: Array<Record<string, unknown>> }>
    >`
      SELECT findings FROM content_analysis_observation_chunks
      WHERE run_id = ${queued.run.id}
    `;
    expect(stored?.findings[0]).not.toHaveProperty("path");
    expect(stored?.findings[0]).not.toHaveProperty("box");
  });

  it("publishes an unchanged fractional duration after PostgreSQL float32 round-trip", async () => {
    const queued = await store.enqueue(
      intent("fractional-duration", { sourceDurationSeconds: 0.72 })
    );
    const lease = await claim(queued.run.durableJobId, "fractional-token");
    await store.updateProgress(queued.run.id, lease, {
      phase: "publishing",
      scannedSeconds: 0.72,
      sampledFrames: 0,
      positiveFrames: 0,
    });

    await expect(
      store.publish({
        runId: queued.run.id,
        lease,
        source: {
          id: source.id,
          sourceFingerprint: source.sourceFingerprint,
          durationSeconds: 0.72,
        },
        events: [],
      })
    ).resolves.toMatchObject({ status: "completed", isPublished: true });
  });

  it("publishes a zero-result generation while preserving manual and edited automatic bookmarks", async () => {
    const old = await store.enqueue(intent("old"));
    await publish(
      old.run,
      [event("old-keep", 10), event("old-delete", 20)],
      "old-token"
    );

    const [{ id: editedBookmarkId }] = await client<Array<{ id: number }>>`
      UPDATE bookmarks
      SET user_modified_at = clock_timestamp()
      WHERE id = (
        SELECT id FROM bookmarks
        WHERE analysis_run_id = ${old.run.id}
        ORDER BY id
        LIMIT 1
      )
      RETURNING id
    `;
    const [{ id: manualBookmarkId }] = await client<Array<{ id: number }>>`
      INSERT INTO bookmarks (video_id, user_id, timestamp_seconds, name)
      VALUES (1, 1, 90, 'Manual')
      RETURNING id
    `;

    await client`INSERT INTO videos (id) VALUES (2) ON CONFLICT DO NOTHING`;
    const otherSource = {
      id: 2,
      sourceFingerprint: "partial-sha256-v1:other-video",
      durationSeconds: 120,
    };
    const other = await store.enqueue(
      intent("other-video", {
        videoId: otherSource.id,
        sourceFingerprint: otherSource.sourceFingerprint,
        sourceDurationSeconds: otherSource.durationSeconds,
      })
    );
    const otherLease = await claim(other.run.durableJobId, "other-video-token");
    await store.updateProgress(other.run.id, otherLease, {
      phase: "publishing",
      scannedSeconds: otherSource.durationSeconds,
      sampledFrames: 1,
      positiveFrames: 1,
    });
    await store.publish({
      runId: other.run.id,
      lease: otherLease,
      source: otherSource,
      events: [event("other-video")],
    });
    const [{ id: otherBookmarkId }] = await client<Array<{ id: number }>>`
      SELECT id FROM bookmarks WHERE analysis_run_id = ${other.run.id}
    `;

    const next = await store.enqueue(
      intent("old", { force: true, requestDigest: "request:old:forced" })
    );
    const published = await publish(next.run, [], "zero-token");

    expect(published).toMatchObject({
      status: "completed",
      isPublished: true,
      resultEventCount: 0,
      resultBookmarkCount: 0,
    });
    const bookmarks = await client<
      Array<{ id: number; origin: string; video_id: number }>
    >`
      SELECT id, origin, video_id FROM bookmarks ORDER BY id
    `;
    expect([...bookmarks]).toEqual([
      { id: editedBookmarkId, origin: "automatic", video_id: 1 },
      { id: manualBookmarkId, origin: "manual", video_id: 1 },
      { id: otherBookmarkId, origin: "automatic", video_id: 2 },
    ]);
    const generations = await client<
      Array<{ id: number; is_published: boolean }>
    >`
      SELECT id, is_published FROM content_analysis_runs
      WHERE video_id = 1
      ORDER BY id
    `;
    expect([...generations]).toEqual([
      { id: old.run.id, is_published: false },
      { id: next.run.id, is_published: true },
    ]);
  });

  it("serializes two non-equivalent publications and leaves one current generation", async () => {
    const first = await store.enqueue(intent("concurrent-balanced"));
    const second = await store.enqueue(
      intent("concurrent-thorough", { profile: "thorough" })
    );
    const firstLease = await claim(first.run.durableJobId, "first-token");
    const secondLease = await claim(second.run.durableJobId, "second-token");
    await Promise.all([
      store.updateProgress(first.run.id, firstLease, {
        phase: "publishing",
        scannedSeconds: 120,
        sampledFrames: 1,
        positiveFrames: 1,
      }),
      store.updateProgress(second.run.id, secondLease, {
        phase: "publishing",
        scannedSeconds: 120,
        sampledFrames: 1,
        positiveFrames: 1,
      }),
    ]);

    const results = await Promise.all([
      store.publish({
        runId: first.run.id,
        lease: firstLease,
        source,
        events: [event("first")],
      }),
      store.publish({
        runId: second.run.id,
        lease: secondLease,
        source,
        events: [event("second", 30)],
      }),
    ]);

    expect(results.every((result) => result?.status === "completed")).toBe(
      true
    );
    const [counts] = await client<
      Array<{ completed: number; published: number; published_events: number }>
    >`
      SELECT
        count(*) FILTER (WHERE status = 'completed')::int AS completed,
        count(*) FILTER (WHERE is_published)::int AS published,
        (SELECT count(*)::int FROM content_analysis_events WHERE is_published) AS published_events
      FROM content_analysis_runs
    `;
    expect(counts).toEqual({ completed: 2, published: 1, published_events: 1 });

    const [publication] = await client<
      Array<{
        published_runs: number;
        published_events: number;
        automatic_bookmarks: number;
        linked_current_bookmarks: number;
      }>
    >`
      SELECT
        count(DISTINCT run.id) FILTER (WHERE run.is_published)::int AS published_runs,
        count(DISTINCT event.id) FILTER (WHERE event.is_published)::int AS published_events,
        (SELECT count(*)::int FROM bookmarks WHERE origin = 'automatic') AS automatic_bookmarks,
        count(DISTINCT bookmark.id) FILTER (
          WHERE run.is_published AND event.is_published
            AND bookmark.analysis_run_id = run.id
            AND event.published_bookmark_id = bookmark.id
        )::int AS linked_current_bookmarks
      FROM content_analysis_runs run
      LEFT JOIN content_analysis_events event ON event.run_id = run.id
      LEFT JOIN bookmarks bookmark ON bookmark.id = event.published_bookmark_id
    `;
    expect(publication).toEqual({
      published_runs: 1,
      published_events: 1,
      automatic_bookmarks: 1,
      linked_current_bookmarks: 1,
    });
  });

  it("serializes concurrent forced enqueue after a completed equivalent run", async () => {
    const completed = await store.enqueue(intent("forced-race"));
    await publish(completed.run, [], "forced-race-baseline-token");
    const forced = intent("forced-race", {
      force: true,
      requestDigest: "request:forced-race:forced",
    });

    const results = await Promise.all([
      store.enqueue(forced),
      store.enqueue(forced),
    ]);

    expect(results[0]?.run.id).toBe(results[1]?.run.id);
    expect(results.map(({ reused }) => reused).sort()).toEqual([false, true]);
    const [counts] = await client<Array<{ active: number; total: number }>>`
      SELECT count(*) FILTER (WHERE status IN ('queued', 'running', 'retry_wait'))::int AS active,
             count(*)::int AS total
      FROM content_analysis_runs
      WHERE semantic_generation_key = ${forced.semanticGenerationKey}
    `;
    expect(counts).toEqual({ active: 1, total: 2 });
  });

  it("settles publish versus cancellation without a cancelled published generation", async () => {
    const queued = await store.enqueue(intent("cancel-race"));
    const lease = await claim(queued.run.durableJobId, "cancel-race-token");
    await store.updateProgress(queued.run.id, lease, {
      phase: "publishing",
      scannedSeconds: 120,
      sampledFrames: 0,
      positiveFrames: 0,
    });

    await Promise.all([
      store.cancel(queued.run.id, queued.run.userId),
      store.publish({ runId: queued.run.id, lease, source, events: [] }),
    ]);

    const run = await store.findById(queued.run.id);
    const [job] = await client<Array<{ status: string }>>`
      SELECT status FROM durable_jobs WHERE id = ${queued.run.durableJobId}
    `;
    expect(run).not.toBeNull();
    expect(job).toBeDefined();
    if (!run || !job) throw new Error("Race did not leave terminal records");
    expect(["completed", "cancelled"]).toContain(run.status);
    expect(job.status).toBe(run.status);
    expect(run.status === "cancelled" && run.isPublished).toBe(false);
  });

  it("keeps cancellation and publication terminal transitions deterministic in both orders", async () => {
    const cancelledFirst = await store.enqueue(intent("cancel-first"));
    const cancelledLease = await claim(
      cancelledFirst.run.durableJobId,
      "cancel-first-token"
    );
    await store.updateProgress(cancelledFirst.run.id, cancelledLease, {
      phase: "publishing",
      scannedSeconds: 120,
      sampledFrames: 0,
      positiveFrames: 0,
    });
    const cancelled = await store.cancel(
      cancelledFirst.run.id,
      cancelledFirst.run.userId
    );
    const stalePublish = await store.publish({
      runId: cancelledFirst.run.id,
      lease: cancelledLease,
      source,
      events: [],
    });
    expect(cancelled).toMatchObject({
      status: "cancelled",
      isPublished: false,
    });
    expect(stalePublish).toBeNull();

    const publishedFirst = await store.enqueue(intent("publish-first"));
    const published = await publish(
      publishedFirst.run,
      [event("publish-first")],
      "publish-first-token"
    );
    const lateCancel = await store.cancel(
      publishedFirst.run.id,
      publishedFirst.run.userId
    );
    expect(published).toMatchObject({ status: "completed", isPublished: true });
    expect(lateCancel).toMatchObject({
      status: "completed",
      isPublished: true,
    });
  });

  it("rejects stale leases and changed sources without partial publication", async () => {
    const queued = await store.enqueue(intent("stale-lease-source"));
    const lease = await claim(queued.run.durableJobId, "current-token");

    const wrongToken = await store.updateProgress(
      queued.run.id,
      { ...lease, leaseToken: "wrong-token" },
      {
        phase: "analyzing",
        scannedSeconds: 20,
        sampledFrames: 10,
        positiveFrames: 2,
      }
    );
    expect(wrongToken).toBeNull();

    await client`
      UPDATE durable_jobs
      SET lease_expires_at = clock_timestamp() - interval '1 second'
      WHERE id = ${queued.run.durableJobId}
    `;
    const expired = await store.updateProgress(queued.run.id, lease, {
      phase: "analyzing",
      scannedSeconds: 20,
      sampledFrames: 10,
      positiveFrames: 2,
    });
    expect(expired).toBeNull();

    const freshLease = await claim(queued.run.durableJobId, "fresh-token");
    await store.updateProgress(queued.run.id, freshLease, {
      phase: "publishing",
      scannedSeconds: 120,
      sampledFrames: 1,
      positiveFrames: 1,
    });
    await expect(
      store.publish({
        runId: queued.run.id,
        lease: freshLease,
        source: { ...source, sourceFingerprint: "partial-sha256-v1:changed" },
        events: [event("changed-source")],
      })
    ).rejects.toThrow(
      "Video source fingerprint or duration changed during analysis"
    );

    const [state] = await client<
      Array<{
        job_status: string;
        run_status: string;
        lease_token: string | null;
        events: number;
        bookmarks: number;
      }>
    >`
      SELECT job.status AS job_status, run.status AS run_status,
             job.lease_token,
             (SELECT count(*)::int FROM content_analysis_events) AS events,
             (SELECT count(*)::int FROM bookmarks) AS bookmarks
      FROM durable_jobs job
      JOIN content_analysis_runs run ON run.durable_job_id = job.id
      WHERE run.id = ${queued.run.id}
    `;
    expect(state).toEqual({
      job_status: "running",
      run_status: "running",
      lease_token: "fresh-token",
      events: 0,
      bookmarks: 0,
    });
  });

  it("rolls back a mid-publication failure and makes committed publication replay-safe", async () => {
    const old = await store.enqueue(intent("rollback-old"));
    await publish(old.run, [event("rollback-old")], "rollback-old-token");
    const [{ id: oldBookmarkId }] = await client<Array<{ id: number }>>`
      SELECT id FROM bookmarks WHERE analysis_run_id = ${old.run.id}
    `;

    const next = await store.enqueue(
      intent("rollback-old", {
        force: true,
        requestDigest: "request:rollback-forced",
      })
    );
    const lease = await claim(next.run.durableJobId, "rollback-next-token");
    await store.updateProgress(next.run.id, lease, {
      phase: "publishing",
      scannedSeconds: 120,
      sampledFrames: 2,
      positiveFrames: 2,
    });
    await expect(
      store.publish({
        runId: next.run.id,
        lease,
        source,
        events: [event("duplicate-key", 30), event("duplicate-key", 40)],
      })
    ).rejects.toThrow();

    const [rolledBack] = await client<
      Array<{
        job_status: string;
        next_status: string;
        old_published: boolean;
        old_bookmark_exists: boolean;
        next_events: number;
      }>
    >`
      SELECT job.status AS job_status, next.status AS next_status,
             old.is_published AS old_published,
             EXISTS(SELECT 1 FROM bookmarks WHERE id = ${oldBookmarkId}) AS old_bookmark_exists,
             (SELECT count(*)::int FROM content_analysis_events WHERE run_id = next.id) AS next_events
      FROM content_analysis_runs next
      JOIN durable_jobs job ON job.id = next.durable_job_id
      JOIN content_analysis_runs old ON old.id = ${old.run.id}
      WHERE next.id = ${next.run.id}
    `;
    expect(rolledBack).toEqual({
      job_status: "running",
      next_status: "running",
      old_published: true,
      old_bookmark_exists: true,
      next_events: 0,
    });

    const committed = await store.publish({
      runId: next.run.id,
      lease,
      source,
      events: [event("committed-after-rollback", 30)],
    });
    expect(committed).toMatchObject({ status: "completed", isPublished: true });
    const replay = await store.publish({
      runId: next.run.id,
      lease,
      source,
      events: [event("committed-after-rollback", 30)],
    });
    expect(replay).toBeNull();

    const [counts] = await client<
      Array<{ events: number; bookmarks: number; published: number }>
    >`
      SELECT
        (SELECT count(*)::int FROM content_analysis_events WHERE run_id = ${next.run.id}) AS events,
        (SELECT count(*)::int FROM bookmarks WHERE analysis_run_id = ${next.run.id}) AS bookmarks,
        (SELECT count(*)::int FROM content_analysis_runs WHERE is_published) AS published
    `;
    expect(counts).toEqual({ events: 1, bookmarks: 1, published: 1 });
  });

  it("rolls back stale error transitions and rejects checkpoint regression atomically", async () => {
    const claimed = await store.enqueue(intent("checkpoint-owner"));
    const other = await store.enqueue(intent("checkpoint-other"));
    const lease = await claim(claimed.run.durableJobId, "checkpoint-token");
    await store.updateProgress(claimed.run.id, lease, {
      phase: "analyzing",
      scannedSeconds: 20,
      sampledFrames: 10,
      positiveFrames: 2,
      cursor: { chunkIndex: 2, itemOffset: 4 },
    });

    await expect(
      store.updateProgress(claimed.run.id, lease, {
        phase: "extracting",
        scannedSeconds: 19,
        sampledFrames: 9,
        positiveFrames: 1,
        cursor: { chunkIndex: 2, itemOffset: 3 },
      })
    ).rejects.toThrow("Invalid content analysis checkpoint");
    await expect(
      store.recordError(other.run.id, lease, {
        status: "failed",
        code: "STALE_OWNER",
        message: "Wrong run for this durable lease",
        retryCount: 0,
        retryDelayMs: 1_000,
      })
    ).rejects.toThrow("missing at error transition");

    const [state] = await client<
      Array<{
        job_status: string;
        run_status: string;
        phase: string;
        scanned_seconds: number;
        checkpoint_scanned: number;
      }>
    >`
      SELECT job.status AS job_status, run.status AS run_status, run.phase,
             run.scanned_seconds,
             (job.checkpoint->'data'->>'scannedSeconds')::real AS checkpoint_scanned
      FROM durable_jobs job
      JOIN content_analysis_runs run ON run.durable_job_id = job.id
      WHERE job.id = ${claimed.run.durableJobId}
    `;
    expect(state).toEqual({
      job_status: "running",
      run_status: "running",
      phase: "analyzing",
      scanned_seconds: 20,
      checkpoint_scanned: 20,
    });
  });
});
