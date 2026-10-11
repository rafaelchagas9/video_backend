import { afterEach, expect, it, mock } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMediaProcess } from "@/utils/media-process";
let directory = tmpdir();
let videoPath = "";
const records: any[] = [];
mock.module("@/config/env", () => ({
  env: {
    DEMO_MODE: false,
    FFMPEG_PATH: "/usr/bin/ffmpeg",
    FFPROBE_PATH: "/usr/bin/ffprobe",
    VAAPI_DEVICE: "",
    get THUMBNAILS_DIR() {
      return directory;
    },
    THUMBNAIL_SIZE: "160x90",
    THUMBNAIL_FORMAT: "webp",
    THUMBNAIL_QUALITY: 80,
  },
}));
mock.module("@/utils/logger", () => ({
  logger: { debug() {}, info() {}, warn() {}, error() {} },
}));
mock.module("@/database/schema", () => ({
  thumbnailsTable: { videoId: "videoId", id: "id" },
}));
mock.module("@/config/drizzle", () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [] }) }),
    }),
    insert: () => ({
      values: (value: any) => {
        records.push(value);
        return { returning: async () => [{ id: 1 }] };
      },
    }),
  },
}));
mock.module("@/modules/videos/videos.service", () => ({
  videosService: {
    findById: async () => ({ file_path: videoPath, duration_seconds: 2 }),
  },
}));
mock.module("@/modules/media/demo-media-assets.service", () => ({
  demoMediaAssetsService: {},
}));
const { FrameExtractionService } =
  await import("@/modules/frame-extraction/frame-extraction.service");
const { ThumbnailsService } =
  await import("@/modules/thumbnails/thumbnails.service");
const { MetadataService } = await import("@/modules/videos/metadata.service");
afterEach(async () => {
  if (directory !== tmpdir())
    await rm(directory, { recursive: true, force: true });
  directory = tmpdir();
  records.length = 0;
});

it("renders and probes generated media, padded frames, JPEG sequences and WebP thumbnails", async () => {
  directory = await mkdtemp(join(tmpdir(), "media-tools-smoke-"));
  videoPath = join(directory, "generated-source.mp4");
  await runMediaProcess(
    "/usr/bin/ffmpeg",
    [
      "-nostdin",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=128x96:r=4:d=2",
      "-an",
      "-c:v",
      "mpeg4",
      videoPath,
    ],
    {
      label: "Synthetic media generation",
      timeoutMs: 10_000,
      includeStderr: true,
    }
  );
  const metadata = new MetadataService();
  expect(await metadata.extractMetadata(videoPath)).toMatchObject({
    width: 128,
    height: 96,
    duration_seconds: 2,
    fps: 4,
  });
  const frames = new FrameExtractionService(directory);
  const single = await frames.extractFrame({
    videoPath,
    timestampSeconds: 0.5,
    outputDir: directory,
    targetWidth: 160,
    targetHeight: 90,
    outputFormat: "png",
  });
  expect(await metadata.extractMetadata(single)).toMatchObject({
    width: 160,
    height: 90,
  });
  const sequence = await frames.extractFrames({
    videoId: 1,
    videoPath,
    videoDuration: 2,
    intervalSeconds: 1,
    targetWidth: 64,
    outputFormat: "webp",
    tempDir: directory,
  });
  expect(sequence.frames).toHaveLength(2);
  for (const frame of sequence.frames) {
    expect(frame.filePath).toEndWith(".jpg");
    expect(await metadata.extractMetadata(frame.filePath)).toMatchObject({
      width: 64,
      height: 48,
    });
    expect((await stat(frame.filePath)).size).toBeGreaterThan(0);
  }
  const thumbnails = new ThumbnailsService();
  thumbnails.findById = async () => ({ id: 1 }) as any;
  await thumbnails.generate(1, { timestamp: 0.5 });
  expect(await metadata.extractMetadata(records[0].filePath)).toMatchObject({
    width: 160,
    height: 90,
    codec: "webp",
  });
  await thumbnails.saveFromFrame(1, {
    ...sequence.frames[0]!,
    width: 64,
    height: 48,
  });
  expect(await metadata.extractMetadata(records[1].filePath)).toMatchObject({
    width: 160,
    height: 90,
    codec: "webp",
  });
  await frames.cleanupFrames(sequence.tempDirectory, { removeDirectory: true });
});
