import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type postgres from "postgres";
import type { PerceptualDuplicatesEngineResult } from "@/modules/perceptual-duplicates/perceptual-duplicates.schemas";
import { CATALOG_REVISION } from "@/modules/perceptual-duplicates/perceptual-catalog.schemas";
import type {
  PerceptualDuplicatesRunner,
  PerceptualDuplicatesRunnerInput,
} from "@/modules/perceptual-duplicates/perceptual-duplicates.runner";
import { mediaWorkScheduler } from "@/utils/media-work-scheduler";
import {
  applyTestDatabaseEnv,
  assertTestDatabaseEnvironment,
  migrateTestDatabase,
  startTestDatabase,
} from "../helpers/test-database";

type Runtime =
  import("@/modules/perceptual-duplicates/perceptual-duplicates.runtime").PerceptualDuplicatesRuntime;
type JobView =
  import("@/modules/perceptual-duplicates/perceptual-duplicates.types").PerceptualDuplicatesJobView;

describe("perceptual duplicate durable runtime", () => {
  let database: Awaited<ReturnType<typeof startTestDatabase>>;
  let closeDatabase: typeof import("@/config/drizzle").closeDrizzleDatabase;
  let sql: ReturnType<typeof postgres>;
  let runtime: Runtime;
  let mediaDirectory: string;
  let mediaPaths: string[];
  let videoIds: number[];
  let runnerCalls = 0;
  let resultRevision = CATALOG_REVISION;

  const runner: PerceptualDuplicatesRunner = {
    async run(
      input: PerceptualDuplicatesRunnerInput
    ): Promise<PerceptualDuplicatesEngineResult> {
      runnerCalls += 1;
      if (runnerCalls === 2) {
        await writeFile(input.videos[0]!.path, "changed-during-analysis");
      }
      return {
        version: 1,
        revision: resultRevision,
        videos: input.videos.map((video) => ({
          id: video.id,
          frame_count: 60,
          duration_seconds: video.duration_seconds,
        })),
        matches: [],
        runtime: {
          inference_provider: "MIGraphXExecutionProvider",
          onnxruntime: "1.25.0",
          precision: "fp32",
          decode: "vaapi",
          model_sha256: "a".repeat(64),
          initialization_seconds: 0.01,
          elapsed_seconds: 0.02,
          sample_rate: 1,
          verification_rate: 5,
          candidate_limit_per_pair: 8,
          candidate_limited_pairs: 0,
        },
      };
    },
  };

  async function waitForTerminal(
    jobId: number,
    userId: number
  ): Promise<JobView> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const job = await runtime.get(jobId, userId);
      if (["completed", "failed", "cancelled"].includes(job.status)) return job;
      await Bun.sleep(50);
    }
    throw new Error(`Timed out waiting for perceptual duplicate job ${jobId}`);
  }

  beforeAll(async () => {
    database = await startTestDatabase();
    applyTestDatabaseEnv(database);
    const { env } = await import("@/config/env");
    assertTestDatabaseEnvironment(database, env);
    await migrateTestDatabase();

    const postgres = (await import("postgres")).default;
    sql = postgres(database.connectionString);
    mediaDirectory = await mkdtemp(join(tmpdir(), "perceptual-runtime-"));
    const paths = [
      join(mediaDirectory, "one.mp4"),
      join(mediaDirectory, "two.mp4"),
    ];
    mediaPaths = paths;
    await Promise.all(
      paths.map((path, index) => writeFile(path, `video-${index}`))
    );
    const [directory] = await sql<Array<{ id: number }>>`
      INSERT INTO watched_directories (path) VALUES (${mediaDirectory}) RETURNING id
    `;
    const inserted = await sql<Array<{ id: number }>>`
      INSERT INTO videos
        (file_path, file_name, directory_id, file_size_bytes, duration_seconds, is_available)
      VALUES
        (${paths[0]}, 'one.mp4', ${directory!.id}, 7, 60, true),
        (${paths[1]}, 'two.mp4', ${directory!.id}, 7, 90, true)
      RETURNING id
    `;
    videoIds = inserted.map(({ id }) => id);

    ({ closeDrizzleDatabase: closeDatabase } =
      await import("@/config/drizzle"));
    const { PerceptualDuplicatesRuntime } =
      await import("@/modules/perceptual-duplicates/perceptual-duplicates.runtime");
    runtime = new PerceptualDuplicatesRuntime(runner, {
      perceptualEnabled: true,
    });
  }, 120_000);

  afterAll(async () => {
    await runtime?.stop();
    await sql?.end({ timeout: 5 });
    await closeDatabase?.();
    await database?.stop();
    await rm(mediaDirectory, { recursive: true, force: true });
  }, 30_000);

  it("deduplicates concurrent requests, scopes ownership, and cancels durably", async () => {
    const requests = await Promise.all([
      runtime.start({ userId: 101, videoIds }),
      runtime.start({ userId: 101, videoIds: [...videoIds].reverse() }),
    ]);

    expect(new Set(requests.map(({ job }) => job.id)).size).toBe(1);
    expect(requests.filter(({ reused }) => reused)).toHaveLength(1);
    await expect(runtime.get(requests[0]!.job.id, 202)).rejects.toThrow(
      "Perceptual duplicate job not found"
    );

    const cancelled = await runtime.cancel(requests[0]!.job.id, 101);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.result).toBeNull();
  });

  it("publishes only lease-owned results for unchanged source files", async () => {
    const queued = await runtime.start({ userId: 303, videoIds });
    await runtime.start();
    const completed = await waitForTerminal(queued.job.id, 303);

    expect(completed.status).toBe("completed");
    expect(completed.result?.revision).toBe(CATALOG_REVISION);
    expect(completed.result?.videos.map(({ id }) => id)).toEqual(videoIds);

    await sql`
      UPDATE durable_jobs
      SET status = 'cancelled', cancelled_at = clock_timestamp()
      WHERE id = ${queued.job.id}
    `;
    const cancelledAfterCheckpoint = await runtime.get(queued.job.id, 303);
    expect(cancelledAfterCheckpoint.status).toBe("cancelled");
    expect(cancelledAfterCheckpoint.result).toBeNull();
  });

  it("does not publish a result when a source changes during comparison", async () => {
    const queued = await runtime.start({ userId: 404, videoIds });
    const failed = await waitForTerminal(queued.job.id, 404);

    expect(failed.status).toBe("failed");
    expect(failed.result).toBeNull();
    expect(failed.error).toEqual({
      code: "SOURCE_CHANGED",
      message: "One or more selected videos changed during comparison",
    });
  });

  it("captures source identity only after background scheduler admission", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blockers = [
      mediaWorkScheduler.run("background", () => gate),
      mediaWorkScheduler.run("background", () => gate),
    ];
    try {
      const queued = await runtime.start({ userId: 505, videoIds });
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const job = await runtime.get(queued.job.id, 505);
        if (
          job.phase === "preparing" &&
          mediaWorkScheduler.status.waiting > 0
        ) {
          break;
        }
        await Bun.sleep(25);
      }
      expect(mediaWorkScheduler.status.waiting).toBeGreaterThan(0);
      expect((await runtime.get(queued.job.id, 505)).phase).toBe("preparing");
      await writeFile(mediaPaths[0]!, "changed-while-waiting-for-admission");
      release();
      await Promise.all(blockers);

      const completed = await waitForTerminal(queued.job.id, 505);
      expect(completed.status).toBe("completed");
      expect(completed.result?.revision).toBe(CATALOG_REVISION);
    } finally {
      release();
      await Promise.allSettled(blockers);
    }
  });

  it("hides completed legacy results and fails active legacy jobs before decode", async () => {
    const [current] = await sql<Array<{ checkpoint: unknown }>>`
      SELECT checkpoint FROM durable_jobs
      WHERE kind = 'vision.perceptual-duplicates' AND status = 'completed'
      ORDER BY id LIMIT 1`;
    const legacyPayload = {
      version: 1,
      userId: 606,
      videoIds,
      requestDigest: `sha256:${"b".repeat(64)}`,
    };
    const [completedLegacy] = await sql<Array<{ id: number }>>`
      INSERT INTO durable_jobs (kind,payload,checkpoint,status,completed_at)
      VALUES (
        'vision.perceptual-duplicates',
        ${sql.json(legacyPayload)},
        ${sql.json(JSON.parse(JSON.stringify(current!.checkpoint)))},
        'completed',
        clock_timestamp()
      ) RETURNING id`;
    const stale = await runtime.get(completedLegacy!.id, 606);
    expect(stale.status).toBe("failed");
    expect(stale.phase).toBe("failed");
    expect(stale.result).toBeNull();
    expect(stale.error).toEqual({
      code: "PERCEPTUAL_DUPLICATES_GENERATION_STALE",
      message:
        "This comparison belongs to an earlier engine revision; start a new comparison",
    });

    const callsBefore = runnerCalls;
    const [activeLegacy] = await sql<Array<{ id: number }>>`
      INSERT INTO durable_jobs (kind,payload)
      VALUES ('vision.perceptual-duplicates', ${sql.json({
        ...legacyPayload,
        userId: 607,
      })}) RETURNING id`;
    const failed = await waitForTerminal(activeLegacy!.id, 607);
    expect(failed.status).toBe("failed");
    expect(failed.error?.code).toBe("PERCEPTUAL_DUPLICATES_GENERATION_STALE");
    expect(runnerCalls).toBe(callsBefore);
  });

  it("rejects an engine result from a different revision before publication", async () => {
    resultRevision = "sscd-regions-sift-temporal-v2";
    try {
      const queued = await runtime.start({ userId: 608, videoIds });
      const failed = await waitForTerminal(queued.job.id, 608);
      expect(failed.status).toBe("failed");
      expect(failed.result).toBeNull();
      expect(failed.error?.code).toBe("ENGINE_INVALID_RESULT");
    } finally {
      resultRevision = CATALOG_REVISION;
    }
  });

  it("rejects new and queued work before decode while the engine is gated off", async () => {
    await runtime.stop();
    const { PerceptualDuplicatesRuntime } =
      await import("@/modules/perceptual-duplicates/perceptual-duplicates.runtime");
    runtime = new PerceptualDuplicatesRuntime(runner, {
      perceptualEnabled: false,
    });
    const callsBefore = runnerCalls;
    await expect(
      runtime.start({ userId: 609, videoIds })
    ).rejects.toMatchObject({ code: "COPY_ENGINE_NOT_READY", statusCode: 503 });

    const [queued] = await sql<Array<{ id: number }>>`
      INSERT INTO durable_jobs (kind,payload)
      VALUES ('vision.perceptual-duplicates', ${sql.json({
        version: 2,
        generation: CATALOG_REVISION,
        userId: 610,
        videoIds,
        requestDigest: `sha256:${"c".repeat(64)}`,
      })}) RETURNING id`;
    await runtime.start();
    const failed = await waitForTerminal(queued!.id, 610);
    expect(failed.status).toBe("failed");
    expect(failed.error).toEqual({
      code: "COPY_ENGINE_NOT_READY",
      message:
        "Perceptual duplicate analysis is disabled by server configuration; face and timeline jobs are available.",
    });
    expect(runnerCalls).toBe(callsBefore);
  });
});
