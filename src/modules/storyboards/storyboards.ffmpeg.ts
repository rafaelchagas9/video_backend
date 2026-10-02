import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";
import { mediaWorkScheduler } from "@/utils/media-work-scheduler";
import {
  PAGE_COLUMNS,
  PAGE_ROWS,
  TILES_PER_PAGE,
  storyboardPageCount,
  storyboardPageSize,
  type StoryboardFormat,
} from "./storyboards.pages";

export type StoryboardSampling = "auto" | "precise" | "keyframes";
export interface StoryboardRenderOptions {
  inputPath: string;
  /** One path per page, in order; see storyboards.pages. */
  outputPaths: string[];
  durationSeconds: number;
  tileWidth: number;
  tileHeight: number;
  intervalSeconds: number;
  format: StoryboardFormat;
  quality: number;
  sampling?: StoryboardSampling;
}
interface RendererOptions {
  ffmpegPath: string;
  vaapiDevice?: string;
  maxKeyframeDriftSeconds?: number;
  timeoutMs?: number;
}

/** Compare the available keyframe with the midpoint sampled by the existing FPS filter. */
export function keyframesCoverStoryboard(
  timestamps: readonly number[],
  duration: number,
  interval: number,
  maxDrift: number
): boolean {
  if (!timestamps.length) return false;
  let index = 0;
  for (let tile = 0; tile < Math.ceil(duration / interval); tile++) {
    const midpoint = Math.min(duration, (tile + 0.5) * interval);
    while (
      index + 1 < timestamps.length &&
      timestamps[index + 1]! < (tile + 0.5) * interval
    )
      index++;
    if (Math.abs(midpoint - timestamps[index]!) > maxDrift) return false;
  }
  return true;
}

// Name the encoder: for .webp ffmpeg defaults to libwebp_anim, which folds
// every page into one animated file instead of writing one file per page.
function encoderArguments(format: StoryboardFormat, quality: number) {
  return format === "webp"
    ? ["-c:v", "libwebp", "-q:v", String(quality)]
    : [
        "-c:v",
        "mjpeg",
        "-qscale:v",
        String(Math.round(2 + ((100 - quality) / 100) * 29)),
      ];
}

/** Writes one image per page, numbered from 0, via the image2 muxer. */
function pageOutputArguments(options: {
  outputPaths: string[];
  format: StoryboardFormat;
  quality: number;
}, outputPattern: string) {
  return [
    "-frames:v",
    String(options.outputPaths.length),
    "-fps_mode",
    "passthrough",
    "-an",
    "-sn",
    "-dn",
    ...encoderArguments(options.format, options.quality),
    "-f",
    "image2",
    "-start_number",
    "0",
    outputPattern,
  ];
}

export function buildStoryboardArguments(
  options: StoryboardRenderOptions,
  outputPattern: string,
  keyframes: boolean,
  vaapiDevice?: string
): string[] {
  const {
    tileWidth: w,
    tileHeight: h,
    intervalSeconds: interval,
  } = options;
  const count = Math.ceil(options.durationSeconds / interval);
  const scale = vaapiDevice
    ? `scale_vaapi=w=${w}:h=${h}:force_original_aspect_ratio=decrease,hwdownload,format=nv12`
    : `scale=w=${w}:h=${h}:force_original_aspect_ratio=decrease`;
  const filter = [
    ...(keyframes ? ["showinfo=checksum=0"] : []),
    `fps=1/${interval}:start_time=0:eof_action=pass`,
    scale,
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`,
    // Explicitly cover the last partial interval and clips shorter than one interval.
    // Bound cloned frames before tiling so the encoder always terminates.
    "tpad=stop_mode=clone:stop=-1",
    `trim=end_frame=${count}`,
    `tile=${PAGE_COLUMNS}x${PAGE_ROWS}`,
  ].join(",");
  return [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    keyframes ? "info" : "error",
    "-n",
    ...(vaapiDevice
      ? [
          "-hwaccel",
          "vaapi",
          "-hwaccel_device",
          vaapiDevice,
          "-hwaccel_output_format",
          "vaapi",
        ]
      : []),
    ...(keyframes ? ["-skip_frame", "nokey"] : []),
    "-i",
    options.inputPath,
    "-map",
    "0:v:0",
    "-vf",
    filter,
    ...pageOutputArguments(options, outputPattern),
  ];
}

/** Re-cut a legacy single sheet into pages; see scripts/paginate-storyboards.ts. */
export function buildPaginateArguments(options: PaginateSheetOptions, outputPattern: string): string[] {
  const { cols, rows, tileWidth: w, tileHeight: h, tileCount } = options;
  return [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-n",
    "-i",
    options.sheetPath,
    "-vf",
    [
      // Sheets are exactly cols×rows tiles; crop guards against any padding.
      `crop=${cols * w}:${rows * h}:0:0`,
      `untile=${cols}x${rows}`,
      `trim=end_frame=${tileCount}`,
      `tile=${PAGE_COLUMNS}x${PAGE_ROWS}`,
    ].join(","),
    ...pageOutputArguments(options, outputPattern),
  ];
}

export interface PaginateSheetOptions {
  sheetPath: string;
  outputPaths: string[];
  cols: number;
  rows: number;
  tileWidth: number;
  tileHeight: number;
  tileCount: number;
  format: StoryboardFormat;
  quality: number;
}

/**
 * Move rendered pages into place. ffmpeg pads the last page to a full grid;
 * trim it to its tiles first so page size always matches the VTT cues.
 * Publication is all-or-nothing, and never overwrites an existing file.
 */
async function publishPages(
  temporaryPage: (page: number) => string,
  options: {
    outputPaths: string[];
    tileCount: number;
    tileWidth: number;
    tileHeight: number;
    format: StoryboardFormat;
    quality: number;
  }
): Promise<void> {
  const last = options.outputPaths.length - 1;
  for (let page = 0; page <= last; page++) {
    const produced = await stat(temporaryPage(page)).catch(() => null);
    if (!produced?.size)
      throw new Error("Storyboard decoder produced no image");
  }
  const size = storyboardPageSize(
    last,
    options.tileCount,
    options.tileWidth,
    options.tileHeight
  );
  if (options.tileCount - last * TILES_PER_PAGE < TILES_PER_PAGE) {
    const source = temporaryPage(last);
    const trimmed = `${source}.trim`;
    const image = sharp(source).extract({ left: 0, top: 0, ...size });
    await (options.format === "webp"
      ? image.webp({ quality: options.quality })
      : image.jpeg({ quality: options.quality })
    ).toFile(trimmed);
    await rename(trimmed, source);
  }
  const published: string[] = [];
  try {
    for (let page = 0; page <= last; page++) {
      await copyFile(
        temporaryPage(page),
        options.outputPaths[page]!,
        constants.COPYFILE_EXCL
      );
      published.push(options.outputPaths[page]!);
    }
  } catch (error) {
    await Promise.all(published.map((path) => unlink(path).catch(() => {})));
    throw error;
  }
}

async function removeTemporaryPages(
  temporaryPage: (page: number) => string,
  pages: number
) {
  await Promise.all(
    Array.from({ length: pages + 1 }, (_, page) =>
      Promise.all([
        unlink(temporaryPage(page)).catch(() => {}),
        unlink(`${temporaryPage(page)}.trim`).catch(() => {}),
      ])
    )
  );
}

function temporaryPages(outputPaths: string[], format: StoryboardFormat) {
  const prefix = `${outputPaths[0]}.${randomUUID()}`;
  return {
    pattern: `${prefix}.%d.${format}`,
    page: (page: number) => `${prefix}.${page}.${format}`,
  };
}

/** Tile already-extracted frame images (face analysis) into pages. */
export async function assembleFramePages(
  framePaths: string[],
  options: {
    outputPaths: string[];
    tileWidth: number;
    tileHeight: number;
    format: StoryboardFormat;
    quality: number;
  },
  ffmpegPath = "ffmpeg"
): Promise<void> {
  const tileCount = framePaths.length;
  if (
    tileCount < 1 ||
    options.outputPaths.length !== storyboardPageCount(tileCount)
  )
    throw new Error("Invalid storyboard assembly target");
  const temporary = temporaryPages(options.outputPaths, options.format);
  const listPath = `${temporary.page(0)}.txt`;
  const { tileWidth: w, tileHeight: h } = options;
  try {
    await writeFile(
      listPath,
      framePaths
        .map((path) => `file '${path.replaceAll("'", "'\\''")}'`)
        .join("\n"),
      "utf-8"
    );
    await renderAttempt(
      ffmpegPath,
      [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-n",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        listPath,
        "-vf",
        `scale=w=${w}:h=${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,tile=${PAGE_COLUMNS}x${PAGE_ROWS}`,
        ...pageOutputArguments(options, temporary.pattern),
      ],
      10 * 60_000
    );
    await publishPages(temporary.page, { ...options, tileCount });
  } finally {
    await unlink(listPath).catch(() => {});
    await removeTemporaryPages(temporary.page, options.outputPaths.length);
  }
}

export async function paginateSheet(
  options: PaginateSheetOptions,
  ffmpegPath = "ffmpeg",
  timeoutMs = 10 * 60_000
): Promise<void> {
  if (
    options.tileCount < 1 ||
    options.tileCount > options.cols * options.rows ||
    options.outputPaths.length !== storyboardPageCount(options.tileCount)
  )
    throw new Error("Invalid storyboard pagination target");
  const temporary = temporaryPages(options.outputPaths, options.format);
  try {
    await renderAttempt(
      ffmpegPath,
      buildPaginateArguments(options, temporary.pattern),
      timeoutMs
    );
    await publishPages(temporary.page, options);
  } finally {
    await removeTemporaryPages(temporary.page, options.outputPaths.length);
  }
}

async function renderAttempt(
  ffmpegPath: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal
): Promise<number[]> {
  signal?.throwIfAborted();
  return new Promise((resolveAttempt, reject) => {
    const child = spawn(ffmpegPath, args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    const timestamps: number[] = [];
    let pending = "";
    let failure: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const terminate = () => {
      child.kill("SIGTERM");
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), 2_000);
      killTimer.unref();
    };
    const timer = setTimeout(() => {
      failure = new Error("Storyboard generation timed out");
      terminate();
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", terminate);
    };
    signal?.addEventListener("abort", terminate, { once: true });
    child.stderr.on("data", (data: Buffer) => {
      pending += data.toString();
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      if (pending.length > 64 * 1024) pending = "";
      for (const line of lines) {
        const match =
          /showinfo[^\n]*\bn:\s*\d+[^\n]*\bpts_time:([+\-\deE.]+)/.exec(line);
        if (!match) continue;
        const pts = Number(match[1]);
        if (!Number.isFinite(pts) || pts < 0 || timestamps.length >= 100_000) {
          failure = new Error("Unsupported storyboard timestamps");
          terminate();
          return;
        }
        timestamps.push(pts);
      }
    });
    child.once("error", () => {
      cleanup();
      reject(new Error("Could not start storyboard decoder"));
    });
    child.once("close", (code) => {
      cleanup();
      if (signal?.aborted) reject(signal.reason);
      else if (failure) reject(failure);
      else if (code !== 0) reject(new Error("Storyboard decoder failed"));
      else resolveAttempt(timestamps);
    });
  });
}

/** Render to a private sibling first; existing files are never overwritten on failure. */
export class StoryboardRenderer {
  constructor(private readonly options: RendererOptions) {}

  async render(
    input: StoryboardRenderOptions,
    signal?: AbortSignal
  ): Promise<{ sampling: "keyframes" | "precise"; hardware: boolean }> {
    const count = Math.ceil(input.durationSeconds / input.intervalSeconds);
    if (
      !Number.isFinite(count) ||
      count < 1 ||
      input.outputPaths.length !== storyboardPageCount(count) ||
      input.outputPaths.some(
        (path) => resolve(input.inputPath) === resolve(path)
      )
    )
      throw new Error("Invalid storyboard render target");
    return mediaWorkScheduler.run(
      "interactive",
      async () => {
        const sampling = input.sampling ?? "auto";
        const strategies =
          sampling === "precise"
            ? [false]
            : sampling === "keyframes"
              ? [true]
              : [true, false];
        let lastError: unknown;
        for (const keyframes of strategies) {
          for (const device of this.options.vaapiDevice
            ? [this.options.vaapiDevice, undefined]
            : [undefined]) {
            signal?.throwIfAborted();
            const temporary = temporaryPages(input.outputPaths, input.format);
            try {
              const timestamps = await renderAttempt(
                this.options.ffmpegPath,
                buildStoryboardArguments(
                  input,
                  temporary.pattern,
                  keyframes,
                  device
                ),
                this.options.timeoutMs ?? 10 * 60_000,
                signal
              );
              if (
                keyframes &&
                sampling === "auto" &&
                !keyframesCoverStoryboard(
                  timestamps,
                  input.durationSeconds,
                  input.intervalSeconds,
                  this.options.maxKeyframeDriftSeconds ?? 5
                )
              ) {
                // A software decoder has the same sparse keyframes. Go directly to full decoding.
                break;
              }
              await publishPages(temporary.page, {
                ...input,
                tileCount: count,
              });
              return {
                sampling: keyframes ? "keyframes" : "precise",
                hardware: Boolean(device),
              };
            } catch (error) {
              if (signal?.aborted) throw signal.reason;
              if ((error as NodeJS.ErrnoException).code === "EEXIST")
                throw error;
              lastError = error;
            } finally {
              await removeTemporaryPages(
                temporary.page,
                input.outputPaths.length
              );
            }
          }
        }
        throw lastError ?? new Error("Storyboard generation failed");
      },
      signal
    );
  }
}
