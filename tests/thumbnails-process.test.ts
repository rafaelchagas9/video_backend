import { afterEach, expect, it, mock } from "bun:test";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
let directory = tmpdir();
let fail = false;
const calls: { args: string[]; options: any }[] = [];
const inserts: any[] = [];
mock.module("@/config/env", () => ({
  env: {
    DEMO_MODE: false,
    get THUMBNAILS_DIR() {
      return directory;
    },
    THUMBNAIL_SIZE: "160x90",
    THUMBNAIL_FORMAT: "webp",
    THUMBNAIL_QUALITY: 80,
    THUMBNAIL_POSITION_PERCENT: 50,
    FFMPEG_PATH: "/fixture-ffmpeg",
    VAAPI_DEVICE: "/fixture-device",
  },
}));
mock.module("@/utils/logger", () => ({ logger: { debug() {}, error() {} } }));
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
        inserts.push(value);
        return { returning: async () => [{ id: 1 }] };
      },
    }),
  },
}));
mock.module("@/modules/videos/videos.service", () => ({
  videosService: {
    findById: async () => ({
      file_path: "/synthetic input.mkv",
      duration_seconds: 60,
    }),
  },
}));
mock.module("@/modules/media/demo-media-assets.service", () => ({
  demoMediaAssetsService: {},
}));
mock.module("@/utils/media-process", () => ({
  runMediaProcess: async (
    _executable: string,
    args: string[],
    options: any
  ) => {
    calls.push({ args, options });
    await writeFile(args.at(-1)!, "synthetic image fixture");
    if (fail) throw new Error("Fixture encoder failed");
    return { stdout: "", stderr: "" };
  },
}));
const { ThumbnailsService } =
  await import("@/modules/thumbnails/thumbnails.service");
afterEach(async () => {
  if (directory !== tmpdir())
    await rm(directory, { recursive: true, force: true });
  directory = tmpdir();
  calls.length = 0;
  inserts.length = 0;
  fail = false;
});
async function service() {
  directory = await mkdtemp(join(tmpdir(), "thumbnail-process-fixture-"));
  const instance = new ThumbnailsService();
  instance.findById = async () => ({ id: 1 }) as any;
  return instance;
}

it("retains input seeking, aspect padding, WebP quality and published metadata", async () => {
  const instance = await service();
  const signal = new AbortController().signal;
  await instance.generate(1, { timestamp: 12.5 }, signal);
  const args = calls[0]!.args;
  expect(args.slice(2, 10)).toEqual([
    "-hwaccel",
    "vaapi",
    "-hwaccel_device",
    "/fixture-device",
    "-ss",
    "12.5",
    "-i",
    "/synthetic input.mkv",
  ]);
  expect(args[args.indexOf("-vf") + 1]).toBe(
    "scale=w=160:h=90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2"
  );
  expect(args.slice(-3, -1)).toEqual(["-quality", "80"]);
  expect(calls[0]!.options.signal).toBe(signal);
  expect(inserts[0]).toMatchObject({
    videoId: 1,
    width: 160,
    height: 90,
    timestampSeconds: 12.5,
    fileSizeBytes: 23,
  });
});

it("scales an extracted frame and removes partial output on encoder failure", async () => {
  const instance = await service();
  fail = true;
  await expect(
    instance.saveFromFrame(1, {
      filePath: "/synthetic.jpg",
      timestampSeconds: 4,
      frameIndex: 0,
      width: 400,
      height: 300,
    })
  ).rejects.toThrow("Fixture encoder failed");
  expect(calls[0]!.args.slice(0, 4)).toEqual([
    "-nostdin",
    "-y",
    "-i",
    "/synthetic.jpg",
  ]);
  expect(await readdir(directory)).toEqual([]);
  expect(inserts).toHaveLength(0);
});
