import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, stat, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { mediaWorkScheduler } from "@/utils/media-work-scheduler";

export type StoryboardSampling = "auto" | "precise" | "keyframes";
export interface StoryboardRenderOptions {
  inputPath: string;
  outputPath: string;
  durationSeconds: number;
  tileWidth: number;
  tileHeight: number;
  intervalSeconds: number;
  cols: number;
  rows: number;
  format: "webp" | "jpg";
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

export function buildStoryboardArguments(
  options: StoryboardRenderOptions,
  outputPath: string,
  keyframes: boolean,
  vaapiDevice?: string
): string[] {
  const {
    tileWidth: w,
    tileHeight: h,
    cols,
    rows,
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
    `tile=${cols}x${rows}:nb_frames=${count}`,
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
    "-frames:v",
    "1",
    "-an",
    "-sn",
    "-dn",
    ...(options.format === "webp"
      ? ["-q:v", String(options.quality)]
      : [
          "-qscale:v",
          String(Math.round(2 + ((100 - options.quality) / 100) * 29)),
        ]),
    outputPath,
  ];
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
      count > input.cols * input.rows ||
      resolve(input.inputPath) === resolve(input.outputPath)
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
            const temporary = `${input.outputPath}.${randomUUID()}.${input.format}`;
            try {
              const timestamps = await renderAttempt(
                this.options.ffmpegPath,
                buildStoryboardArguments(input, temporary, keyframes, device),
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
              if ((await stat(temporary)).size === 0)
                throw new Error("Storyboard decoder produced no image");
              await copyFile(
                temporary,
                input.outputPath,
                constants.COPYFILE_EXCL
              );
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
              await unlink(temporary).catch(() => {});
            }
          }
        }
        throw lastError ?? new Error("Storyboard generation failed");
      },
      signal
    );
  }
}
