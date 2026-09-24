import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import type postgres from "postgres";
import type { LibrarySyncAdapters } from "@/modules/library-sync/library-sync.runtime";
import {
  applyTestDatabaseEnv,
  assertTestDatabaseEnvironment,
  migrateTestDatabase,
  startTestDatabase,
} from "../helpers/test-database";

type Runtime =
  import("@/modules/library-sync/library-sync.runtime").LibrarySyncRuntime;
type Run = import("@/modules/library-sync/library-sync.types").LibrarySyncRun;

describe("library sync durable runtime", () => {
  let database: Awaited<ReturnType<typeof startTestDatabase>>;
  let sql: ReturnType<typeof postgres>;
  let closeDatabase: typeof import("@/config/drizzle").closeDrizzleDatabase;
  let runtime: Runtime;
  let videoIds: number[] = [];
  const calls: Array<string> = [];
  const adapters: LibrarySyncAdapters = {
    perceptual: {
      processedIds: async () => new Set(),
      process: async (id, signal) => {
        signal.throwIfAborted();
        calls.push(`perceptual:${id}`);
        return { compared_videos: 2, match_count: 0, truncated_matches: false };
      },
      results: async ({ limit, offset }) => ({
        items: [],
        assessment_revision: "relevance-v1",
        diagnostics: {
          candidate_limited_pairs: 0,
          truncated_videos: 0,
          suppressed_matches: 0,
        },
        total: 0,
        limit,
        offset,
      }),
    },
    faces: {
      processedIds: async (ids) => new Set(ids.slice(0, 1)),
      process: async (id, signal) => {
        signal.throwIfAborted();
        calls.push(`faces:${id}`);
        return { faces_detected: 0 };
      },
    },
    storyboards: {
      processedIds: async () => new Set(),
      process: async (id, signal) => {
        signal.throwIfAborted();
        calls.push(`storyboards:${id}`);
        return { generated: true };
      },
    },
  };
  async function terminal(id: number): Promise<Run> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const run = await runtime.getRun(id);
      if (["completed", "failed", "cancelled"].includes(run.status)) return run;
      await Bun.sleep(25);
    }
    throw new Error("library sync job timed out");
  }
  beforeAll(async () => {
    database = await startTestDatabase();
    applyTestDatabaseEnv(database);
    const { env } = await import("@/config/env");
    assertTestDatabaseEnvironment(database, env);
    await migrateTestDatabase();
    const postgres = (await import("postgres")).default;
    sql = postgres(database.connectionString);
    const [directory] = await sql<
      Array<{ id: number }>
    >`INSERT INTO watched_directories (path) VALUES ('/tmp/library-sync-fixture') RETURNING id`;
    const inserted = await sql<
      Array<{ id: number }>
    >`INSERT INTO videos (file_path,file_name,directory_id,file_size_bytes,duration_seconds,is_available) VALUES ('/tmp/library-sync-a.mp4','a.mp4',${directory!.id},10,30,true),('/tmp/library-sync-b.mp4','b.mp4',${directory!.id},10,40,true) RETURNING id`;
    videoIds = inserted.map((v) => v.id);
    ({ closeDrizzleDatabase: closeDatabase } =
      await import("@/config/drizzle"));
    const { LibrarySyncRuntime } =
      await import("@/modules/library-sync/library-sync.runtime");
    runtime = new LibrarySyncRuntime(adapters, { perceptualEnabled: true });
  }, 120_000);
  afterAll(async () => {
    await runtime?.stop();
    await sql?.end({ timeout: 5 });
    await closeDatabase?.();
    await database?.stop();
  }, 30_000);
  it("deduplicates an equivalent manual run and rejects a competing task set", async () => {
    const [first, second] = await Promise.all([
      runtime.startRun({ tasks: ["faces", "perceptual"], userId: 1 }),
      runtime.startRun({ tasks: ["perceptual", "faces"], userId: 2 }),
    ]);
    expect(first.run.id).toBe(second.run.id);
    expect([first.reused, second.reused].sort()).toEqual([false, true]);
    await expect(
      runtime.startRun({ tasks: ["storyboards"], userId: 1 })
    ).rejects.toThrow("already active");
    const cancelled = await runtime.cancelRun(first.run.id);
    expect(cancelled.status).toBe("cancelled");
  });
  it("checkpoints every video and preserves completed zero-face analysis", async () => {
    const queued = await runtime.startRun({
      tasks: ["faces", "storyboards"],
      userId: 1,
    });
    await runtime.start();
    const done = await terminal(queued.run.id);
    expect(done.status).toBe("completed");
    expect(done.progress).toMatchObject({
      total: 4,
      processed: 4,
      completed: 3,
      skipped: 1,
      failed: 0,
      pending: 0,
      current: null,
    });
    expect(calls).toEqual(
      expect.arrayContaining([
        `faces:${videoIds[1]}`,
        `storyboards:${videoIds[0]}`,
        `storyboards:${videoIds[1]}`,
      ])
    );
    expect(calls).not.toContain(`faces:${videoIds[0]}`);
  });
  it("reports a terminal item error once and preserves its safe code while continuing", async () => {
    const telemetry = await import("@/utils/telemetry");
    const { logger } = await import("@/utils/logger");
    const capture = spyOn(
      telemetry,
      "captureTelemetryException"
    ).mockImplementation(() => {});
    const log = spyOn(logger, "error").mockImplementation(() => {});
    const previous = adapters.perceptual.process;
    const failure = Object.assign(new Error("private /media/source.mp4"), {
      code: "COPY_DECODE_FAILED",
    });
    adapters.perceptual.process = async (id, signal) => {
      if (id === videoIds[0]) throw failure;
      return previous(id, signal);
    };
    try {
      const queued = await runtime.startRun({
        tasks: ["perceptual"],
        userId: 1,
      });
      const done = await terminal(queued.run.id);
      expect(done.status).toBe("completed");
      expect(done.progress.failed).toBe(1);
      expect(done.progress.completed).toBe(1);
      expect(
        done.recentItems.find((item) => item.videoId === videoIds[0])?.error
      ).toEqual({
        code: "COPY_DECODE_FAILED",
        message: "Video could not be decoded for perceptual analysis",
      });
      expect(capture).toHaveBeenCalledTimes(1);
      expect(capture).toHaveBeenCalledWith(failure, {
        source: "library_sync_item",
        jobId: queued.run.id,
        videoId: videoIds[0],
        task: "perceptual",
      });
      expect(log).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(done.recentItems)).not.toContain("/media/");
    } finally {
      adapters.perceptual.process = previous;
      capture.mockRestore();
      log.mockRestore();
    }
  });
  it("baselines existing media and deduplicates automatic enqueue for a new video", async () => {
    await runtime.updateSettings({ autoPerceptual: true });
    const [directory] = await sql<
      Array<{ id: number }>
    >`SELECT id FROM watched_directories LIMIT 1`;
    const [created] = await sql<
      Array<{ id: number }>
    >`INSERT INTO videos (file_path,file_name,directory_id,file_size_bytes,duration_seconds,is_available) VALUES ('/tmp/library-sync-c.mp4','c.mp4',${directory!.id},10,50,true) RETURNING id`;
    const first = await runtime.enqueueNewVideo(created!.id);
    const second = await runtime.enqueueNewVideo(created!.id);
    expect(first?.id).toBe(second?.id);
    expect(first).toMatchObject({
      tasks: ["perceptual"],
      trigger: "automatic",
    });
    if (first) expect((await terminal(first.id)).status).toBe("completed");
  });

  it("publishes the automatic setting with its baseline under one transition", async () => {
    await runtime.updateSettings({ autoPerceptual: false });
    await sql`UPDATE app_settings SET value = '0' WHERE key = 'library_sync_auto_perceptual_watermark_video_id'`;
    await sql`UPDATE app_settings SET value = 'old-generation' WHERE key = 'library_sync_auto_perceptual_generation'`;

    await runtime.updateSettings({ autoPerceptual: true });

    const [state] = await sql<
      Array<{
        enabled: string;
        generation: string;
        watermark: string;
        maxId: number;
      }>
    >`SELECT
        MAX(value) FILTER (WHERE key = 'library_sync_auto_perceptual') AS enabled,
        MAX(value) FILTER (WHERE key = 'library_sync_auto_perceptual_generation') AS generation,
        MAX(value) FILTER (WHERE key = 'library_sync_auto_perceptual_watermark_video_id') AS watermark,
        (SELECT MAX(id)::int FROM videos) AS "maxId"
      FROM app_settings`;
    expect(state).toMatchObject({ enabled: "true" });
    expect(state!.generation).toStartWith("library-sync-v2:");
    expect(Number(state!.watermark)).toBe(state!.maxId);
  });

  it("retries a failed automatic item but preserves cancellation as a stop signal", async () => {
    await runtime.updateSettings({ autoPerceptual: true });
    const [directory] = await sql<
      Array<{ id: number }>
    >`SELECT id FROM watched_directories LIMIT 1`;
    const [created] = await sql<
      Array<{ id: number }>
    >`INSERT INTO videos (file_path,file_name,directory_id,file_size_bytes,duration_seconds,is_available) VALUES ('/tmp/library-sync-auto-retry.mp4','auto-retry.mp4',${directory!.id},10,50,true) RETURNING id`;
    const previous = adapters.perceptual.process;
    adapters.perceptual.process = async () => {
      throw Object.assign(new Error("decode failed"), {
        code: "COPY_DECODE_FAILED",
      });
    };
    try {
      const first = await runtime.enqueueNewVideo(created!.id);
      expect(first).not.toBeNull();
      const failedItem = await terminal(first!.id);
      expect(failedItem.status).toBe("completed");
      expect(failedItem.progress.failed).toBe(1);

      let retryStarted = false;
      adapters.perceptual.process = async (_id, signal) => {
        retryStarted = true;
        await new Promise<void>((_resolve, reject) => {
          const abort = () => reject(signal.reason);
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        });
        throw new Error("unreachable");
      };
      const retry = await runtime.enqueueNewVideo(created!.id);
      expect(retry?.id).not.toBe(first!.id);
      const deadline = Date.now() + 5_000;
      while (!retryStarted && Date.now() < deadline) await Bun.sleep(20);
      expect(retryStarted).toBe(true);
      const cancelled = await runtime.cancelRun(retry!.id);
      expect(cancelled.status).toBe("cancelled");
      const afterCancellation = await runtime.enqueueNewVideo(created!.id);
      expect(afterCancellation?.id).toBe(retry!.id);
      expect(afterCancellation?.status).toBe("cancelled");
    } finally {
      adapters.perceptual.process = previous;
    }
  });

  it("starts a fresh automatic baseline when the worker generation changes", async () => {
    await sql`UPDATE app_settings SET value = 'old-generation' WHERE key = 'library_sync_auto_perceptual_generation'`;
    await sql`UPDATE app_settings SET value = '0' WHERE key = 'library_sync_auto_perceptual_watermark_video_id'`;
    const result = await runtime.enqueueNewVideo(videoIds[0]!);
    expect(result).toBeNull();
    const [state] = await sql<
      Array<{ generation: string; watermark: string }>
    >`SELECT
        MAX(value) FILTER (WHERE key = 'library_sync_auto_perceptual_generation') AS generation,
        MAX(value) FILTER (WHERE key = 'library_sync_auto_perceptual_watermark_video_id') AS watermark
      FROM app_settings`;
    expect(state!.generation).toStartWith("library-sync-v2:");
    const [{ maxId }] = await sql<Array<{ maxId: number }>>`SELECT MAX(id)::int AS "maxId" FROM videos`;
    expect(Number(state!.watermark)).toBe(maxId);
  });

  it("restarts only invalidated perceptual progress in a legacy run", async () => {
    const before = calls.length;
    const [legacy] = await sql<
      Array<{ id: number }>
    >`INSERT INTO durable_jobs (kind,payload,checkpoint)
      VALUES (
        'library.sync',
        ${sql.json({
          version: 1,
          userId: 1,
          tasks: ["perceptual"],
          trigger: "manual",
          videoIds,
        })},
        ${sql.json({
          stage: "executing",
          completedUnits: 1,
          totalUnits: 2,
          data: {
            progress: {
              total: 2,
              processed: 1,
              completed: 1,
              failed: 0,
              skipped: 0,
              pending: 1,
              current: null,
              byTask: {
                perceptual: { total: 2, processed: 1, completed: 1, failed: 0, skipped: 0, pending: 1 },
                faces: { total: 0, processed: 0, completed: 0, failed: 0, skipped: 0, pending: 0 },
                storyboards: { total: 0, processed: 0, completed: 0, failed: 0, skipped: 0, pending: 0 },
              },
            },
            recentItems: [],
            taskIndex: 0,
            videoIndex: 1,
          },
        })}
      ) RETURNING id`;
    const done = await terminal(legacy!.id);
    expect(done.status).toBe("completed");
    expect(done.generation).toBeNull();
    expect(done.error).toBeNull();
    expect(done.progress).toMatchObject({ processed: 2, completed: 2, pending: 0 });
    expect(calls.slice(before)).toEqual([
      `perceptual:${videoIds[0]}`,
      `perceptual:${videoIds[1]}`,
    ]);
  });

  it("preserves a legacy face-only cursor across a perceptual revision", async () => {
    const before = calls.length;
    const [legacy] = await sql<Array<{ id: number }>>`
      INSERT INTO durable_jobs (kind,payload,checkpoint)
      VALUES (
        'library.sync',
        ${sql.json({
          version: 1,
          userId: 1,
          tasks: ["faces"],
          trigger: "manual",
          videoIds,
        })},
        ${sql.json({
          stage: "executing",
          completedUnits: 1,
          totalUnits: 2,
          data: {
            progress: {
              total: 2,
              processed: 1,
              completed: 1,
              failed: 0,
              skipped: 0,
              pending: 1,
              current: null,
              byTask: {
                perceptual: { total: 0, processed: 0, completed: 0, failed: 0, skipped: 0, pending: 0 },
                faces: { total: 2, processed: 1, completed: 1, failed: 0, skipped: 0, pending: 1 },
                storyboards: { total: 0, processed: 0, completed: 0, failed: 0, skipped: 0, pending: 0 },
              },
            },
            recentItems: [{ task: "faces", videoId: videoIds[0], status: "completed", result: { faces_detected: 0 }, error: null }],
            taskIndex: 0,
            videoIndex: 1,
          },
        })}
      ) RETURNING id`;
    const done = await terminal(legacy!.id);
    expect(done.status).toBe("completed");
    expect(done.progress).toMatchObject({ processed: 2, completed: 2, pending: 0 });
    expect(calls.slice(before)).toEqual([`faces:${videoIds[1]}`]);
  });

  it("replays perceptual work then resumes later mixed-task progress", async () => {
    const before = calls.length;
    const [legacy] = await sql<Array<{ id: number }>>`
      INSERT INTO durable_jobs (kind,payload,checkpoint)
      VALUES (
        'library.sync',
        ${sql.json({
          version: 2,
          generation: "library-sync-v2:old-perceptual",
          userId: 1,
          tasks: ["faces", "perceptual", "storyboards"],
          trigger: "manual",
          videoIds,
        })},
        ${sql.json({
          stage: "executing",
          completedUnits: 5,
          totalUnits: 6,
          data: {
            generation: "library-sync-v2:old-perceptual",
            progress: {
              total: 6,
              processed: 5,
              completed: 5,
              failed: 0,
              skipped: 0,
              pending: 1,
              current: null,
              byTask: {
                faces: { total: 2, processed: 2, completed: 2, failed: 0, skipped: 0, pending: 0 },
                perceptual: { total: 2, processed: 2, completed: 2, failed: 0, skipped: 0, pending: 0 },
                storyboards: { total: 2, processed: 1, completed: 1, failed: 0, skipped: 0, pending: 1 },
              },
            },
            recentItems: [
              { task: "storyboards", videoId: videoIds[0], status: "completed", result: { generated: true }, error: null },
              { task: "perceptual", videoId: videoIds[1], status: "completed", result: { match_count: 0 }, error: null },
            ],
            taskIndex: 2,
            videoIndex: 1,
          },
        })}
      ) RETURNING id`;
    const done = await terminal(legacy!.id);
    expect(done.status).toBe("completed");
    expect(done.progress).toMatchObject({ processed: 6, completed: 6, pending: 0 });
    expect(done.recentItems.some((item) => item.task === "perceptual" && item.videoId === videoIds[1])).toBe(true);
    expect(calls.slice(before)).toEqual([
      `perceptual:${videoIds[0]}`,
      `perceptual:${videoIds[1]}`,
      `storyboards:${videoIds[1]}`,
    ]);
  });

  it("persists the current video and aborts before starting the next item", async () => {
    const started: number[] = [];
    let observedSignal: AbortSignal | undefined;
    adapters.perceptual.process = async (id, signal) => {
      started.push(id);
      observedSignal = signal;
      await new Promise<void>((_resolve, reject) => {
        const abort = () => reject(signal.reason);
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
      throw new Error("unreachable");
    };
    const queued = await runtime.startRun({ tasks: ["perceptual"], userId: 1 });
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const current = await runtime.getRun(queued.run.id);
      if (current.progress.current) break;
      await Bun.sleep(20);
    }
    expect((await runtime.getRun(queued.run.id)).progress.current).toEqual({
      task: "perceptual",
      videoId: videoIds[0],
    });
    const cancelled = await runtime.cancelRun(queued.run.id);
    expect(cancelled.status).toBe("cancelled");
    expect(observedSignal?.aborted).toBe(true);
    expect(started).toEqual([videoIds[0]]);
  });

  it("resumes an expired lease from the last per-video checkpoint", async () => {
    const started: number[] = [];
    adapters.perceptual.process = async (id, signal) => {
      started.push(id);
      if (id === videoIds[1]) {
        await new Promise<void>((_resolve, reject) => {
          const abort = () => reject(signal.reason);
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        });
      }
      return { compared_videos: 1, match_count: 0, truncated_matches: false };
    };
    const queued = await runtime.startRun({ tasks: ["perceptual"], userId: 1 });
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const current = await runtime.getRun(queued.run.id);
      if (
        current.progress.processed === 1 &&
        current.progress.current?.videoId === videoIds[1]
      )
        break;
      await Bun.sleep(20);
    }
    await runtime.stop();
    await sql`UPDATE durable_jobs SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = ${queued.run.id}`;
    adapters.perceptual.process = async (id, signal) => {
      signal.throwIfAborted();
      started.push(id);
      return { compared_videos: 1, match_count: 0, truncated_matches: false };
    };
    const { LibrarySyncRuntime } =
      await import("@/modules/library-sync/library-sync.runtime");
    runtime = new LibrarySyncRuntime(adapters, { perceptualEnabled: true });
    await runtime.start();
    const completed = await terminal(queued.run.id);
    expect(completed.status).toBe("completed");
    expect(completed.progress.processed).toBe(queued.run.progress.total);
    expect(started.filter((id) => id === videoIds[0])).toHaveLength(1);
  });

  it("stops the run on a systemic cache failure without leaking private details", async () => {
    const started: number[] = [];
    adapters.perceptual.process = async (id) => {
      started.push(id);
      throw Object.assign(new Error("private /srv/media/path"), {
        code: "COPY_CACHE_FULL",
      });
    };
    const queued = await runtime.startRun({ tasks: ["perceptual"], userId: 1 });
    const failed = await terminal(queued.run.id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toEqual({
      code: "COPY_CACHE_FULL",
      message: "Perceptual duplicate cache is full",
    });
    expect(started).toEqual([videoIds[0]]);
    expect(JSON.stringify(failed)).not.toContain("/srv/media/path");
  });

  it("keeps face work available while the perceptual engine is gated off", async () => {
    await runtime.stop();
    const { LibrarySyncRuntime, LIBRARY_SYNC_GENERATION } =
      await import("@/modules/library-sync/library-sync.runtime");
    runtime = new LibrarySyncRuntime(adapters, { perceptualEnabled: false });

    const overview = await runtime.overview();
    expect(overview.capabilities.perceptual).toEqual({
      enabled: false,
      code: "COPY_ENGINE_NOT_READY",
      reason:
        "Perceptual duplicate analysis is disabled by server configuration; face and timeline jobs are available.",
    });
    expect(overview.settings.autoPerceptual).toBe(false);
    await expect(
      runtime.startRun({ tasks: ["perceptual"], userId: 1 })
    ).rejects.toMatchObject({ code: "COPY_ENGINE_NOT_READY", statusCode: 503 });
    await expect(
      runtime.updateSettings({ autoPerceptual: true })
    ).rejects.toMatchObject({ code: "COPY_ENGINE_NOT_READY", statusCode: 503 });
    expect(await runtime.enqueueNewVideo(videoIds[0]!)).toBeNull();

    const before = calls.length;
    const [queued] = await sql<Array<{ id: number }>>`
      INSERT INTO durable_jobs (kind,payload)
      VALUES ('library.sync', ${sql.json({
        version: 2,
        generation: LIBRARY_SYNC_GENERATION,
        userId: 1,
        tasks: ["perceptual", "faces"],
        trigger: "manual",
        videoIds,
      })}) RETURNING id`;
    await runtime.start();
    const done = await terminal(queued!.id);
    expect(done.status).toBe("completed");
    expect(done.progress.byTask.perceptual.failed).toBe(videoIds.length);
    expect(done.recentItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          task: "perceptual",
          error: expect.objectContaining({ code: "COPY_ENGINE_NOT_READY" }),
        }),
      ])
    );
    expect(calls.slice(before)).not.toContainEqual(
      expect.stringContaining("perceptual:")
    );
    expect(calls.slice(before)).toContain(`faces:${videoIds[1]}`);

    const [directory] = await sql<Array<{ id: number }>>`
      SELECT id FROM watched_directories LIMIT 1`;
    const [addedWhileDisabled] = await sql<Array<{ id: number }>>`
      INSERT INTO videos (file_path,file_name,directory_id,file_size_bytes,duration_seconds,is_available)
      VALUES ('/tmp/library-sync-disabled.mp4','disabled.mp4',${directory!.id},10,50,true)
      RETURNING id`;
    expect(await runtime.enqueueNewVideo(addedWhileDisabled!.id)).toBeNull();

    await runtime.stop();
    runtime = new LibrarySyncRuntime(adapters, { perceptualEnabled: true });
    await runtime.start();
    expect(await runtime.enqueueNewVideo(addedWhileDisabled!.id)).toBeNull();
    const [addedAfterEnable] = await sql<Array<{ id: number }>>`
      INSERT INTO videos (file_path,file_name,directory_id,file_size_bytes,duration_seconds,is_available)
      VALUES ('/tmp/library-sync-enabled.mp4','enabled.mp4',${directory!.id},10,50,true)
      RETURNING id`;
    const automatic = await runtime.enqueueNewVideo(addedAfterEnable!.id);
    expect(automatic).toMatchObject({
      tasks: ["perceptual"],
      trigger: "automatic",
    });
  });
});
