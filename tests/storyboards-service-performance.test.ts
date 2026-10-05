import { afterAll, expect, it, mock } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = await mkdtemp(join(tmpdir(), "storyboard-service-test-"));
afterAll(async () => rm(root, { recursive: true, force: true }));
const settings = {
  DEMO_MODE: false,
  NODE_ENV: "test",
  STORYBOARDS_DIR: root,
  STORYBOARD_MAX_CONCURRENT: 2,
  STORYBOARD_TILE_SHORT_SIDE: 36,
  STORYBOARD_INTERVAL_SECONDS: 5,
  STORYBOARD_FORMAT: "webp",
  STORYBOARD_QUALITY: 80,
  STORYBOARD_MAX_TILES: 100,
  STORYBOARD_SAMPLING: "auto",
};
mock.module("@/config/env", () => ({ env: settings }));
mock.module("@/utils/logger", () => ({
  logger: { debug() {}, info() {}, warn() {}, error() {} },
}));
mock.module("@/utils/telemetry", () => ({ captureTelemetryException() {} }));
mock.module("@/utils/performance-profiler", () => ({
  recordPerfStage: async () => {},
}));
mock.module("@/modules/media/demo-media-assets.service", () => ({
  demoMediaAssetsService: {},
}));
mock.module("@/database/demo", () => ({
  resolveDemoAssetPath: (path: string) => path,
}));
const events: string[] = [];
mock.module("@/modules/events/events.service", () => ({
  eventsService: {
    broadcastToAuthenticated(event: { type: string }) {
      events.push(event.type);
    },
  },
}));
mock.module("@/modules/videos/videos.service", () => ({
  videosService: {
    findById: async (id: number) => ({
      id,
      title: "Synthetic fixture",
      file_path: join(root, "source.mkv"),
      width: 128,
      height: 72,
      duration_seconds: 10.8,
    }),
  },
}));
const previous = {
  id: 1,
  videoId: 42,
  spritePath: join(root, "storyboard_42_old.webp"),
  vttPath: join(root, "storyboard_42_old.vtt"),
  generatedAt: new Date(),
};
let row: Record<string, unknown> = previous;
let rejectPublication = true;
const query = {
  from() {
    return this;
  },
  where() {
    return this;
  },
  limit: async () => [row],
};
mock.module("@/config/drizzle", () => ({
  db: {
    select: () => query,
    insert: () => ({
      values(value: Record<string, unknown>) {
        return {
          onConflictDoUpdate: () => ({
            returning: async () => {
              if (rejectPublication)
                throw new Error("Synthetic publication failure");
              row = { ...value, id: 1, generatedAt: new Date() };
              return [row];
            },
          }),
        };
      },
    }),
  },
}));
let renders = 0;
let renderBarrier: Promise<void> | undefined;
mock.module("@/modules/storyboards/storyboards.ffmpeg", () => ({
  assembleFramePages: async () => {},
  StoryboardRenderer: class {
    async render(input: { outputPaths: string[] }) {
      renders++;
      await renderBarrier;
      for (const path of input.outputPaths) await writeFile(path, "new-sprite");
      return { sampling: "keyframes", hardware: false };
    }
  },
}));
const { StoryboardsService } =
  await import("@/modules/storyboards/storyboards.service");

it("keeps an existing preview on publication failure and coalesces duplicate generation", async () => {
  await writeFile(previous.spritePath, "old-sprite");
  await writeFile(previous.vttPath, "old-vtt");
  await writeFile(join(root, "source.mkv"), "original-media");
  const service = new StoryboardsService();
  const first = service.generate(42),
    duplicate = service.generate(42);
  expect(first).toBe(duplicate);
  await expect(first).rejects.toThrow("Synthetic publication failure");
  expect(renders).toBe(1);
  expect(await readFile(previous.spritePath, "utf8")).toBe("old-sprite");
  expect((await readdir(root)).sort()).toEqual([
    "source.mkv",
    "storyboard_42_old.vtt",
    "storyboard_42_old.webp",
  ]);
  rejectPublication = false;
  const result = await service.generate(42);
  expect(result.tile_count).toBe(3);
  expect(await readFile(result.vtt_path, "utf8")).toContain(
    "00:00:10.000 --> 00:00:10.800"
  );
  expect(await readFile(join(root, "source.mkv"), "utf8")).toBe(
    "original-media"
  );
});

it("honors storyboard concurrency and prevents duplicate queue entries during racing lookups", async () => {
  const service = new StoryboardsService();
  service.findByVideoId = async () => {
    await Promise.resolve();
    return null;
  };
  const started: number[] = [];
  const releases: Array<() => void> = [];
  service.generate = async (id) => {
    started.push(id);
    await new Promise<void>((resolve) => releases.push(resolve));
    return {} as Awaited<ReturnType<typeof service.generate>>;
  };
  await Promise.all([
    service.queueGenerate(1),
    service.queueGenerate(1),
    service.queueGenerate(2),
    service.queueGenerate(3),
  ]);
  await Bun.sleep(10);
  expect(started).toEqual([1, 2]);
  releases[0]!();
  await Bun.sleep(10);
  expect(started).toEqual([1, 2, 3]);
  releases.forEach((release) => release());
  await Bun.sleep(10);
});

it("reports manual background progress, deduplicates retries, and recovers after publication failure", async () => {
  const service = new StoryboardsService();
  let release!: () => void;
  renderBarrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  rejectPublication = true;
  events.length = 0;
  const before = renders;
  await service.queueGenerate(42, { intervalSeconds: 10 }, true);
  await service.queueGenerate(42, { intervalSeconds: 5 }, true);
  await Bun.sleep(5);
  expect((await service.getGenerationStatus(42)).status).toBe("processing");
  expect(renders).toBe(before + 1);
  release();
  await Bun.sleep(20);
  expect((await service.getGenerationStatus(42)).status).toBe("failed");
  expect(events).toEqual(["storyboard:generating", "storyboard:error"]);
  rejectPublication = false;
  renderBarrier = undefined;
  await service.queueGenerate(42, { intervalSeconds: 10 }, true);
  await Bun.sleep(20);
  expect((await service.getGenerationStatus(42)).status).toBe("ready");
  expect(row.intervalSeconds).toBe(10);
  expect(events).toEqual([
    "storyboard:generating",
    "storyboard:error",
    "storyboard:generating",
    "storyboard:ready",
  ]);
});
