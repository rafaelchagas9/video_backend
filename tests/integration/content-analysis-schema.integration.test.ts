import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import postgres from "postgres";
import { startTestDatabase } from "../helpers/test-database";

type TestDatabase = Awaited<ReturnType<typeof startTestDatabase>>;

const migrationPaths = [
  "0039_freezing_daimon_hellstrom.sql",
  "0040_overrated_dreaming_celestial.sql",
  "0041_fresh_talkback.sql",
  "0042_even_prism.sql",
].map((migration) =>
  resolve(process.cwd(), "src/database/drizzle-migrations", migration)
);

describe("content-analysis schema migrations 0039 through 0042", () => {
  let database: TestDatabase;
  let sql: ReturnType<typeof postgres>;
  let firstRunId: number;
  let ownerId: number;
  let videoId: number;

  async function expectConstraintViolation(
    code: string,
    run: (isolatedSql: ReturnType<typeof postgres>) => Promise<unknown>
  ): Promise<void> {
    const isolatedSql = postgres(database.connectionString, { max: 1 });
    let caught: unknown;
    try {
      await run(isolatedSql);
    } catch (error) {
      caught = error;
    } finally {
      await isolatedSql.end({ timeout: 5 });
    }
    expect(caught).toBeInstanceOf(postgres.PostgresError);
    expect(caught).toMatchObject({ code });
  }

  beforeAll(async () => {
    database = await startTestDatabase();
    sql = postgres(database.connectionString, { max: 4 });

    await sql`CREATE TABLE users (id serial PRIMARY KEY)`;
    await sql`CREATE TABLE videos (id serial PRIMARY KEY)`;
    await sql`CREATE TABLE durable_jobs (id serial PRIMARY KEY)`;
    await sql`
      CREATE TABLE bookmarks (
        id serial PRIMARY KEY,
        analysis_run_id integer
      )
    `;

    for (const migrationPath of migrationPaths) {
      const migration = await readFile(migrationPath, "utf8");
      for (const statement of migration.split("--> statement-breakpoint")) {
        if (statement.trim()) await sql.unsafe(statement);
      }
    }

    [{ id: ownerId }] = await sql<Array<{ id: number }>>`
      INSERT INTO users DEFAULT VALUES RETURNING id
    `;
    [{ id: videoId }] = await sql<Array<{ id: number }>>`
      INSERT INTO videos DEFAULT VALUES RETURNING id
    `;
    const [{ id: durableJobId }] = await sql<Array<{ id: number }>>`
      INSERT INTO durable_jobs DEFAULT VALUES RETURNING id
    `;
    [{ id: firstRunId }] = await sql<Array<{ id: number }>>`
      INSERT INTO content_analysis_runs (
        durable_job_id, video_id, user_id, profile, requested_categories,
        source_duration_seconds, source_fingerprint, analyzer_revision,
        model_revision, taxonomy_revision, config_revision, idempotency_key,
        request_digest, semantic_generation_key
      ) VALUES (
        ${durableJobId}, ${videoId}, ${ownerId}, 'balanced',
        '["BUTTOCKS_EXPOSED"]'::jsonb, 120, 'source:v1', 'analyzer:v1',
        'model:v1', 'taxonomy:v1', 'config:v1', 'request-1',
        'request-digest:1', 'semantic:1'
      )
      RETURNING id
    `;
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await database?.stop();
  }, 30_000);

  it("accepts a durable run with the complete source and revision snapshot", async () => {
    const [run] = await sql<
      Array<{
        status: string;
        phase: string;
        requested_categories: string[];
        request_digest: string;
      }>
    >`
      SELECT status, phase, requested_categories, request_digest
      FROM content_analysis_runs
      WHERE id = ${firstRunId}
    `;

    expect(run).toEqual({
      status: "queued",
      phase: "queued",
      requested_categories: ["BUTTOCKS_EXPOSED"],
      request_digest: "request-digest:1",
    });
  });

  it("accepts the fast keyframe profile after migration 0041", async () => {
    const [{ id: durableJobId }] = await sql<Array<{ id: number }>>`
      INSERT INTO durable_jobs DEFAULT VALUES RETURNING id
    `;
    const [inserted] = await sql<Array<{ profile: string }>>`
      INSERT INTO content_analysis_runs (
        durable_job_id, video_id, user_id, profile, requested_categories,
        source_duration_seconds, source_fingerprint, analyzer_revision,
        model_revision, taxonomy_revision, config_revision, request_digest,
        semantic_generation_key
      ) VALUES (
        ${durableJobId}, ${videoId}, ${ownerId}, 'fast',
        '["BUTTOCKS_EXPOSED"]'::jsonb, 120, 'source:fast', 'analyzer:v3',
        'model:v1', 'taxonomy:v1', 'config:v3', 'request-digest:fast',
        'semantic:fast'
      )
      RETURNING profile
    `;

    expect(inserted?.profile).toBe("fast");
  });

  it("serializes equivalent active work but permits completed semantic history", async () => {
    const [{ id: secondJobId }] = await sql<Array<{ id: number }>>`
      INSERT INTO durable_jobs DEFAULT VALUES RETURNING id
    `;
    const [{ id: thirdJobId }] = await sql<Array<{ id: number }>>`
      INSERT INTO durable_jobs DEFAULT VALUES RETURNING id
    `;

    await expectConstraintViolation(
      "23505",
      (isolatedSql) => isolatedSql`
        INSERT INTO content_analysis_runs (
          durable_job_id, video_id, user_id, profile, requested_categories,
          source_duration_seconds, source_fingerprint, analyzer_revision,
          model_revision, taxonomy_revision, config_revision, request_digest,
          semantic_generation_key
        ) VALUES (
          ${secondJobId}, ${videoId}, ${ownerId}, 'balanced',
          '["BUTTOCKS_EXPOSED"]'::jsonb, 120, 'source:v1', 'analyzer:v1',
          'model:v1', 'taxonomy:v1', 'config:v1', 'request-digest:2',
          'semantic:1'
        )
      `
    );

    await sql`
      UPDATE content_analysis_runs
      SET status = 'completed', phase = 'completed', completed_at = now()
      WHERE id = ${firstRunId}
    `;

    const inserted = await sql<Array<{ id: number }>>`
      INSERT INTO content_analysis_runs (
        durable_job_id, video_id, user_id, profile, requested_categories,
        source_duration_seconds, source_fingerprint, analyzer_revision,
        model_revision, taxonomy_revision, config_revision, request_digest,
        semantic_generation_key
      ) VALUES (
        ${thirdJobId}, ${videoId}, ${ownerId}, 'balanced',
        '["BUTTOCKS_EXPOSED"]'::jsonb, 120, 'source:v1', 'analyzer:v1',
        'model:v1', 'taxonomy:v1', 'config:v1', 'request-digest:3',
        'semantic:1'
      )
      RETURNING id
    `;
    expect(inserted).toHaveLength(1);
  });

  it("keeps explicit idempotency keys stable even when the request digest differs", async () => {
    const [{ id: durableJobId }] = await sql<Array<{ id: number }>>`
      INSERT INTO durable_jobs DEFAULT VALUES RETURNING id
    `;

    await expectConstraintViolation(
      "23505",
      (isolatedSql) => isolatedSql`
        INSERT INTO content_analysis_runs (
          durable_job_id, video_id, user_id, profile, requested_categories,
          source_duration_seconds, source_fingerprint, analyzer_revision,
          model_revision, taxonomy_revision, config_revision, idempotency_key,
          request_digest, semantic_generation_key
        ) VALUES (
          ${durableJobId}, ${videoId}, ${ownerId}, 'thorough',
          '["ANUS_COVERED"]'::jsonb, 120, 'source:v1', 'analyzer:v1',
          'model:v1', 'taxonomy:v1', 'config:v1', 'request-1',
          'different-digest', 'semantic:different'
        )
      `
    );
  });

  it("allows only one published generation per video, user, and analysis kind", async () => {
    await sql`
      UPDATE content_analysis_runs
      SET is_published = true, published_at = now()
      WHERE id = ${firstRunId}
    `;
    const [{ id: durableJobId }] = await sql<Array<{ id: number }>>`
      INSERT INTO durable_jobs DEFAULT VALUES RETURNING id
    `;

    await expectConstraintViolation(
      "23505",
      (isolatedSql) => isolatedSql`
        INSERT INTO content_analysis_runs (
          durable_job_id, video_id, user_id, profile, requested_categories,
          status, phase, source_duration_seconds, source_fingerprint,
          analyzer_revision, model_revision, taxonomy_revision, config_revision,
          request_digest, semantic_generation_key, is_published, published_at,
          completed_at
        ) VALUES (
          ${durableJobId}, ${videoId}, ${ownerId}, 'thorough',
          '["ANUS_COVERED"]'::jsonb, 'completed', 'completed', 120,
          'source:v1', 'analyzer:v1', 'model:v1', 'taxonomy:v1', 'config:v1',
          'request-digest:published', 'semantic:published', true, now(), now()
        )
      `
    );
  });

  it("enforces the selected taxonomy, compact episode interval, and bookmark FK", async () => {
    const [{ id: durableJobId }] = await sql<Array<{ id: number }>>`
      INSERT INTO durable_jobs DEFAULT VALUES RETURNING id
    `;
    await expectConstraintViolation(
      "23514",
      (isolatedSql) => isolatedSql`
        INSERT INTO content_analysis_runs (
          durable_job_id, video_id, user_id, profile, requested_categories,
          source_duration_seconds, source_fingerprint, analyzer_revision,
          model_revision, taxonomy_revision, config_revision, request_digest,
          semantic_generation_key
        ) VALUES (
          ${durableJobId}, ${videoId}, ${ownerId}, 'balanced',
          '["UNSUPPORTED"]'::jsonb, 120, 'source:v1', 'analyzer:v1',
          'model:v1', 'taxonomy:v1', 'config:v1', 'request-digest:invalid',
          'semantic:invalid'
        )
      `
    );
    await expectConstraintViolation(
      "23514",
      (isolatedSql) => isolatedSql`
        INSERT INTO content_analysis_events (
          run_id, generation_key, start_seconds, peak_seconds, end_seconds,
          category_summary
        ) VALUES (
          ${firstRunId}, 'event:invalid', 20, 10, 30,
          '[{"category":"BUTTOCKS_EXPOSED","count":1,"maxScore":0.9,"meanScore":0.9}]'::jsonb
        )
      `
    );
    await expectConstraintViolation(
      "23514",
      (isolatedSql) => isolatedSql`
        INSERT INTO content_analysis_events (
          run_id, generation_key, start_seconds, peak_seconds, end_seconds,
          category_summary, is_published
        ) VALUES (
          ${firstRunId}, 'event:missing-bookmark', 10, 15, 30,
          '[{"category":"BUTTOCKS_EXPOSED","count":1,"maxScore":0.9,"meanScore":0.9}]'::jsonb,
          true
        )
      `
    );
    await expectConstraintViolation(
      "23503",
      (isolatedSql) => isolatedSql`
        INSERT INTO bookmarks (analysis_run_id) VALUES (999999)
      `
    );

    const [{ id: bookmarkId }] = await sql<Array<{ id: number }>>`
      INSERT INTO bookmarks (analysis_run_id) VALUES (${firstRunId}) RETURNING id
    `;
    const events = await sql<Array<{ id: number }>>`
      INSERT INTO content_analysis_events (
        run_id, generation_key, start_seconds, peak_seconds, end_seconds,
        category_summary, published_bookmark_id, is_published
      ) VALUES (
        ${firstRunId}, 'event:1', 10, 15, 30,
        '[{"category":"BUTTOCKS_EXPOSED","count":3,"maxScore":0.9,"meanScore":0.8}]'::jsonb,
        ${bookmarkId}, true
      )
      RETURNING id
    `;
    expect(events).toHaveLength(1);
    const [{ id: transitioningBookmarkId }] = await sql<Array<{ id: number }>>`
      INSERT INTO bookmarks (analysis_run_id) VALUES (${firstRunId}) RETURNING id
    `;
    const transitioningEvents = await sql<Array<{ id: number }>>`
      INSERT INTO content_analysis_events (
        run_id, generation_key, start_seconds, peak_seconds, end_seconds,
        category_summary, published_bookmark_id, is_published
      ) VALUES (
        ${firstRunId}, 'event:transitioning', 40, 45, 50,
        '[{"category":"BUTTOCKS_EXPOSED","count":2,"maxScore":0.8,"meanScore":0.7}]'::jsonb,
        ${transitioningBookmarkId}, false
      )
      RETURNING id
    `;
    expect(transitioningEvents).toHaveLength(1);
  });

  it("deletes automatic bookmarks when video analysis history cascades", async () => {
    const [{ id: cascadingVideoId }] = await sql<Array<{ id: number }>>`
      INSERT INTO videos DEFAULT VALUES RETURNING id
    `;
    const [{ id: durableJobId }] = await sql<Array<{ id: number }>>`
      INSERT INTO durable_jobs DEFAULT VALUES RETURNING id
    `;
    const [{ id: runId }] = await sql<Array<{ id: number }>>`
      INSERT INTO content_analysis_runs (
        durable_job_id, video_id, user_id, profile, requested_categories,
        source_duration_seconds, source_fingerprint, analyzer_revision,
        model_revision, taxonomy_revision, config_revision, request_digest,
        semantic_generation_key
      ) VALUES (
        ${durableJobId}, ${cascadingVideoId}, ${ownerId}, 'balanced',
        '["BUTTOCKS_EXPOSED"]'::jsonb, 120, 'source:cascade', 'analyzer:v1',
        'model:v1', 'taxonomy:v1', 'config:v1', 'request-digest:cascade',
        'semantic:cascade'
      )
      RETURNING id
    `;
    const [{ id: bookmarkId }] = await sql<Array<{ id: number }>>`
      INSERT INTO bookmarks (analysis_run_id) VALUES (${runId}) RETURNING id
    `;

    await sql`DELETE FROM videos WHERE id = ${cascadingVideoId}`;

    const [remaining] = await sql<Array<{ runs: number; bookmarks: number }>>`
      SELECT
        (SELECT count(*)::int FROM content_analysis_runs WHERE id = ${runId}) AS runs,
        (SELECT count(*)::int FROM bookmarks WHERE id = ${bookmarkId}) AS bookmarks
    `;
    expect(remaining).toEqual({ runs: 0, bookmarks: 0 });
  });

  it("stores one media-free observation payload per run, phase, and chunk", async () => {
    const inserted = await sql<Array<{ chunk_index: number }>>`
      INSERT INTO content_analysis_observation_chunks (
        run_id, phase, chunk_index, start_seconds, end_seconds,
        sampled_frames, positive_frames, findings
      ) VALUES (
        ${firstRunId}, 'coarse', 0, 0, 120, 60, 1,
        '[{"timestampSeconds":12.5,"category":"BUTTOCKS_EXPOSED","score":0.91,"providerLabel":"BUTTOCKS_EXPOSED"}]'::jsonb
      )
      RETURNING chunk_index
    `;
    expect([...inserted]).toEqual([{ chunk_index: 0 }]);

    const [payload] = await sql<
      Array<{ findings: Array<Record<string, unknown>> }>
    >`
      SELECT findings
      FROM content_analysis_observation_chunks
      WHERE run_id = ${firstRunId} AND phase = 'coarse' AND chunk_index = 0
    `;
    expect(payload?.findings[0]).not.toHaveProperty("path");
    expect(payload?.findings[0]).not.toHaveProperty("box");

    await expectConstraintViolation(
      "23505",
      (isolatedSql) => isolatedSql`
        INSERT INTO content_analysis_observation_chunks (
          run_id, phase, chunk_index, start_seconds, end_seconds,
          sampled_frames, positive_frames, findings
        ) VALUES (${firstRunId}, 'coarse', 0, 0, 120, 1, 0, '[]'::jsonb)
      `
    );
    await expectConstraintViolation(
      "23514",
      (isolatedSql) => isolatedSql`
        INSERT INTO content_analysis_observation_chunks (
          run_id, phase, chunk_index, start_seconds, end_seconds,
          sampled_frames, positive_frames, findings
        ) VALUES (${firstRunId}, 'publishing', 1, 0, 120, 1, 2, '{}'::jsonb)
      `
    );
  });
});
