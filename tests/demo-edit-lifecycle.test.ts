import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
} from "bun:test";
import { rmSync } from "fs";

process.env.NODE_ENV = "test";
process.env.POSTGRES_USER ||= "demo-edit-test";
process.env.POSTGRES_PASSWORD ||= "demo-edit-test";
process.env.SESSION_SECRET ||=
  "demo-edit-test-session-secret-at-least-32-characters";

// Fail every lifecycle scenario if it accesses production dependencies.
// This also catches indirect calls that a source-file string search misses.
const productionAccess = mock(() => {
  throw new Error("Demo edits must not invoke production infrastructure");
});
const forbiddenService = new Proxy({}, { get: productionAccess });
mock.module("@/config/drizzle", () => ({ db: forbiddenService }));
mock.module("@/modules/edits/edits.queue", () => ({
  editsQueue: forbiddenService,
  EditsQueue: productionAccess,
}));
mock.module("@/modules/edits/edits.processor", () => ({
  editsProcessor: forbiddenService,
  EditsProcessor: productionAccess,
}));
mock.module("fluent-ffmpeg", () => ({ default: productionAccess }));

const databasePath = `/tmp/conversor-video-demo-edits-${process.pid}.sqlite`;
let closeDemoDatabase: () => void;
let setDemoDatabasePathForTests: (path: string | null) => void;
let EditsDemoService: typeof import("@/modules/edits/edits.demo.service").EditsDemoService;
let originalDemoMode: boolean;

const output = (fileName: string, directoryId = 1) => ({
  directory_id: directoryId,
  file_name: fileName,
  format: "mkv" as const,
  video_codec: "av1" as const,
  audio_codec: "opus" as const,
});

const timeline = { segments: [{ start: 0, end: 10, speed: 1 }] };

function removeDatabase(): void {
  for (const suffix of ["", "-shm", "-wal"]) {
    rmSync(`${databasePath}${suffix}`, { force: true });
  }
}

beforeAll(async () => {
  const { env } = await import("@/config/env");
  originalDemoMode = env.DEMO_MODE;
  env.DEMO_MODE = true;

  const demo = await import("@/database/demo");
  setDemoDatabasePathForTests = demo.setDemoDatabasePathForTests;
  closeDemoDatabase = demo.closeDemoDatabase;
  setDemoDatabasePathForTests(databasePath);
  removeDatabase();
  demo.initializeDemoDatabase();

  const sqlite = demo.getDemoSqlite();
  const insertVideo = sqlite.query(`
    INSERT INTO demo_videos (
      id, source_video_id, file_path, file_name, directory_id,
      file_size_bytes, duration_seconds, width, height, codec, bitrate, fps,
      audio_codec, title, description, themes, is_available, indexed_at,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const timestamp = "2026-01-01T12:00:00.000Z";
  insertVideo.run(
    1,
    null,
    "demo_mode/video/sample-with-audio.mp4",
    "sample-with-audio.mp4",
    1,
    1_000_000,
    100,
    1920,
    1080,
    "h264",
    8_000_000,
    30,
    "aac",
    "Demo Sample With Audio",
    null,
    null,
    1,
    timestamp,
    timestamp,
    timestamp
  );
  insertVideo.run(
    2,
    null,
    "demo_mode/video/sample-silent.mp4",
    "sample-silent.mp4",
    1,
    500_000,
    30,
    1280,
    720,
    "h264",
    4_000_000,
    24,
    null,
    "Demo Silent Sample",
    null,
    null,
    1,
    timestamp,
    timestamp,
    timestamp
  );

  ({ EditsDemoService } = await import("@/modules/edits/edits.demo.service"));
});

afterAll(async () => {
  closeDemoDatabase?.();
  setDemoDatabasePathForTests?.(null);
  removeDatabase();
  const { env } = await import("@/config/env");
  env.DEMO_MODE = originalDemoMode;
});

beforeEach(async () => {
  const { getDemoSqlite } = await import("@/database/demo");
  getDemoSqlite().run(
    "DELETE FROM demo_resources WHERE kind IN ('edit-job', 'edit-job-simulation')"
  );
});

afterEach(() => {
  expect(productionAccess).not.toHaveBeenCalled();
});

describe("SQLite demo edit simulation", () => {
  it("provides representative audio and silent-video metadata", async () => {
    const service = new EditsDemoService();
    expect((await service.editingMetadata(1)).audio).toEqual({
      present: true,
      codec: "aac",
      channels: 2,
      sample_rate: 48_000,
      start_time: 0,
      duration: 100,
      end_time: 100,
      covers_video: true,
    });
    expect((await service.editingMetadata(2)).audio).toEqual({
      present: false,
      codec: null,
      channels: null,
      sample_rate: null,
      start_time: null,
      duration: null,
      end_time: null,
      covers_video: false,
    });
  });

  it("validates the isolated SQLite output directory before persisting", async () => {
    const service = new EditsDemoService();
    await expect(
      service.create(1, {
        output: output("unknown-directory.mkv", 999),
        timeline,
      })
    ).rejects.toThrow("Directory not found with id: 999");
    expect((await service.list()).data).toHaveLength(0);
  });

  it("matches production timeline bounds and audio fade validation", async () => {
    const service = new EditsDemoService();
    await expect(
      service.create(1, {
        output: output("past-source-duration"),
        timeline: { segments: [{ start: 90, end: 101 }] },
      })
    ).rejects.toThrow("Timeline segment 0 exceeds the source duration");
    await expect(
      service.create(1, {
        output: output("invalid-fade"),
        timeline: {
          segments: [{ start: 0, end: 10 }],
          audio: { fade_out_seconds: 11 },
        },
      })
    ).rejects.toThrow(
      "Audio fade_out_seconds must fit within the edited duration"
    );
    await expect(
      service.create(1, {
        output: output("invalid-segment-fade"),
        timeline: {
          segments: [
            {
              start: 0,
              end: 4,
              speed: 2,
              audio: { fade_in_seconds: 2.01 },
            },
          ],
        },
      })
    ).rejects.toThrow(
      "Timeline segment 0 audio fade_in_seconds must fit within the edited segment duration"
    );
    await expect(
      service.create(1, {
        output: output("invalid-segment-crop"),
        timeline: {
          segments: [
            {
              start: 0,
              end: 4,
              transform: {
                crop: { x: 0.8, y: 0, width: 0.3, height: 1 },
              },
            },
          ],
        },
      })
    ).rejects.toThrow(
      "Timeline segment 0 crop must fit within normalized video bounds"
    );
    await expect(
      service.create(1, {
        output: output("invalid-segment-volume"),
        timeline: {
          segments: [
            {
              start: 0,
              end: 4,
              audio: { volume: 4.01 },
            },
          ],
        },
      })
    ).rejects.toThrow(
      "Timeline segment 0 audio volume must be between 0 and 4"
    );
    expect((await service.list()).data).toHaveLength(0);
  });

  it("persists queued -> running -> completed progress and a playable result", async () => {
    const service = new EditsDemoService();
    const created = await service.create(1, {
      output: output("demo-edit"),
      timeline,
    });
    expect(created).toMatchObject({
      status: "queued",
      progress: 0,
      outputConfig: { file_name: "demo-edit.mkv" },
    });

    const firstPoll = await new EditsDemoService().getById(created.id);
    expect(firstPoll).toMatchObject({ status: "running", progress: 25 });
    const secondPoll = await new EditsDemoService().getById(created.id);
    expect(secondPoll).toMatchObject({ status: "running", progress: 70 });
    const completed = await new EditsDemoService().getById(created.id);
    expect(completed).toMatchObject({
      status: "completed",
      progress: 100,
      outputVideoId: 1,
      outputPath: "demo_mode/video/sample-with-audio.mp4",
      errorMessage: null,
    });
    expect(await new EditsDemoService().getById(created.id)).toEqual(completed);

    const persisted = await service.list({ videoId: 1, status: "completed" });
    expect(persisted).toMatchObject({
      data: [{ id: created.id, outputVideoId: 1 }],
      pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
    });
  });

  it("offers a deterministic, persistent terminal failure scenario", async () => {
    const service = new EditsDemoService();
    const created = await service.create(1, {
      output: output("demo-fail-render"),
      timeline,
    });
    expect(created.outputConfig.file_name).toBe("demo-fail-render.mkv");

    expect(await service.getById(created.id)).toMatchObject({
      status: "running",
      progress: 25,
    });
    expect(await service.getById(created.id)).toMatchObject({
      status: "running",
      progress: 70,
    });
    const failed = await service.getById(created.id);
    expect(failed).toMatchObject({
      status: "failed",
      progress: 100,
      outputVideoId: null,
      outputPath: null,
    });
    expect(failed.errorMessage).toContain("demo-fail-");
    expect(await new EditsDemoService().getById(created.id)).toEqual(failed);
  });

  it("keeps cancellation terminal without advancing the simulation", async () => {
    const service = new EditsDemoService();
    const created = await service.create(2, {
      output: output("demo-cancelled.mkv"),
      timeline,
    });
    const cancelled = await service.cancel(created.id);
    expect(cancelled).toMatchObject({ status: "cancelled", progress: 0 });
    expect(await new EditsDemoService().getById(created.id)).toEqual(cancelled);
  });

  it("persists segment effects unchanged while keeping the demo isolated", async () => {
    const service = new EditsDemoService();
    const segmentEffectsTimeline = {
      segments: [
        {
          start: 4,
          end: 12,
          speed: 2,
          transform: {
            crop: { x: 0.1, y: 0.2, width: 0.7, height: 0.6 },
            rotate: 90 as const,
          },
          audio: {
            muted: false,
            volume: 0.6,
            fade_in_seconds: 0.5,
            fade_out_seconds: 1,
          },
        },
        {
          start: 20,
          end: 24,
          speed: 1,
          audio: { muted: true },
        },
      ],
      transform: { rotate: 180 as const },
      audio: { volume: 1.25 },
    };
    const created = await service.create(1, {
      output: output("demo-segment-effects"),
      timeline: segmentEffectsTimeline,
    });

    expect(created.timelineConfig).toEqual(segmentEffectsTimeline);
    expect((await service.list({ videoId: 1 })).data).toContainEqual(
      expect.objectContaining({
        id: created.id,
        timelineConfig: segmentEffectsTimeline,
      })
    );
    expect(await service.getById(created.id)).toMatchObject({
      status: "running",
      progress: 25,
      timelineConfig: segmentEffectsTimeline,
    });
  });

  it("clones every terminal state with stored or overridden timelines", async () => {
    const service = new EditsDemoService();
    const storedTimeline = {
      segments: [
        {
          start: 2,
          end: 8,
          speed: 2,
          transform: { rotate: 90 as const },
          audio: { volume: 0.5, fade_in_seconds: 0.25 },
        },
      ],
      transform: { rotate: 180 as const },
      audio: { muted: false, volume: 1.2 },
    };

    const completedSource = await service.create(1, {
      output: output("clone-completed-source"),
      timeline: storedTimeline,
    });
    await service.getById(completedSource.id);
    await service.getById(completedSource.id);
    await service.getById(completedSource.id);

    const clonedStored = await service.clone(completedSource.id, {
      output: output("clone-completed-target"),
    });
    expect(clonedStored).toMatchObject({
      status: "queued",
      videoId: 1,
      outputConfig: { file_name: "clone-completed-target.mkv" },
      timelineConfig: storedTimeline,
    });
    expect(clonedStored.id).not.toBe(completedSource.id);

    const failedSource = await service.create(1, {
      output: output("demo-fail-clone-source"),
      timeline: storedTimeline,
    });
    await service.getById(failedSource.id);
    await service.getById(failedSource.id);
    await service.getById(failedSource.id);
    const override = { segments: [{ start: 20, end: 25, speed: 1 }] };
    expect(
      await service.clone(failedSource.id, {
        output: output("clone-failed-target"),
        timeline: override,
      })
    ).toMatchObject({ timelineConfig: override });

    const cancelledSource = await service.create(1, {
      output: output("clone-cancelled-source"),
      timeline: storedTimeline,
    });
    await service.cancel(cancelledSource.id);
    expect(
      await service.clone(cancelledSource.id, {
        output: output("clone-cancelled-target"),
      })
    ).toMatchObject({ status: "queued", timelineConfig: storedTimeline });
  });

  it("rejects active and missing source jobs when cloning", async () => {
    const service = new EditsDemoService();
    const active = await service.create(1, {
      output: output("clone-active-source"),
      timeline,
    });

    await expect(
      service.clone(active.id, { output: output("clone-active-target") })
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      service.clone(999_999, { output: output("clone-missing-target") })
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
