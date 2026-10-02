import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, readFile, stat, unlink } from "node:fs/promises";
import { setPriority } from "node:os";
import { resolve } from "node:path";
import { mediaWorkScheduler } from "@/utils/media-work-scheduler";

export interface PreviewPlanOptions {
  clipCount: number;
  clipSeconds: number;
  /** Maximum share of the runtime the teaser may cover. */
  maxCoverage: number;
}

export interface PreviewPlan {
  starts: number[];
  clipSeconds: number;
}

/**
 * Spread clips across 5%–90% of the runtime, skipping intros and credits.
 * Short videos get fewer clips so the teaser never replays most of the video;
 * anything too short for one full clip gets a single shorter one.
 */
export function planPreviewClips(
  durationSeconds: number,
  options: PreviewPlanOptions
): PreviewPlan {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0)
    throw new Error("Invalid preview duration");
  const count = Math.max(
    1,
    Math.min(
      options.clipCount,
      Math.floor((durationSeconds * options.maxCoverage) / options.clipSeconds)
    )
  );
  const clipSeconds = Math.min(options.clipSeconds, durationSeconds * 0.9);
  const latestStart = Math.max(0, durationSeconds - clipSeconds - 0.1);
  const starts = Array.from({ length: count }, (_, index) => {
    const at =
      count > 1
        ? durationSeconds * (0.05 + (0.85 * index) / (count - 1))
        : durationSeconds * 0.3;
    return Math.min(at, latestStart);
  });
  return { starts, clipSeconds };
}

export interface PreviewRenderOptions {
  inputPath: string;
  outputPath: string;
  durationSeconds: number;
  hasAudio: boolean;
  plan: PreviewPlanOptions;
  /** Target short side; landscape and vertical sources both fit inside it. */
  height: number;
  crf: number;
  preset: number;
  audioBitrateKbps: number;
}

export function buildPreviewArguments(
  options: PreviewRenderOptions,
  outputPath: string,
  withAudio: boolean,
  vaapiDevice?: string
): string[] {
  const { starts, clipSeconds } = planPreviewClips(
    options.durationSeconds,
    options.plan
  );
  const h = options.height;
  const inputs: string[] = [];
  const filters: string[] = [];
  let labels = "";
  starts.forEach((start, index) => {
    const window = ["-ss", start.toFixed(3), "-t", clipSeconds.toFixed(3)];
    // Audio gets its own input: in badly interleaved files the audio for a
    // timestamp can sit hundreds of MB away, and one shared demuxer then
    // queues minutes of decoded video while it reads ahead (18 GB+ seen).
    const videoInput = withAudio ? index * 2 : index;
    inputs.push(
      // Frames are downloaded for the software encoder; decoding stays on the GPU.
      ...(vaapiDevice
        ? ["-hwaccel", "vaapi", "-hwaccel_device", vaapiDevice]
        : []),
      "-an",
      "-sn",
      "-dn",
      ...window,
      "-i",
      options.inputPath
    );
    if (withAudio)
      inputs.push("-vn", "-sn", "-dn", ...window, "-i", options.inputPath);
    filters.push(
      `[${videoInput}:v:0]scale='if(gt(iw,ih),-2,min(${h},iw))':'if(gt(iw,ih),min(${h},ih),-2)',` +
        `fps=24,format=yuv420p,setsar=1,setpts=PTS-STARTPTS[v${index}]`
    );
    labels += `[v${index}]`;
    if (withAudio) {
      // Short fades hide the click at every cut.
      filters.push(
        `[${videoInput + 1}:a:0]aresample=48000,aformat=channel_layouts=stereo,asetpts=PTS-STARTPTS,` +
          `afade=t=in:d=0.08,afade=t=out:st=${Math.max(0, clipSeconds - 0.12).toFixed(3)}:d=0.12[a${index}]`
      );
      labels += `[a${index}]`;
    }
  });
  filters.push(
    `${labels}concat=n=${starts.length}:v=1:a=${withAudio ? 1 : 0}[v]${withAudio ? "[a]" : ""}`
  );
  return [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-n",
    ...inputs,
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[v]",
    ...(withAudio
      ? [
          "-map",
          "[a]",
          "-c:a",
          "aac",
          "-b:a",
          `${options.audioBitrateKbps}k`,
          "-ac",
          "2",
        ]
      : ["-an"]),
    "-c:v",
    "libsvtav1",
    "-preset",
    String(options.preset),
    "-crf",
    String(options.crf),
    "-g",
    "48",
    "-pix_fmt",
    "yuv420p",
    "-map_metadata",
    "-1",
    "-sn",
    "-dn",
    "-movflags",
    "+faststart",
    outputPath,
  ];
}

interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runProcess(
  command: string,
  args: string[],
  timeoutMs: number,
  options: {
    lowPriority?: boolean;
    signal?: AbortSignal;
    /** Kill the process once its resident memory passes this (Linux only). */
    maxRssBytes?: number;
  } = {}
): Promise<ProcessResult> {
  const { signal } = options;
  signal?.throwIfAborted();
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    if (options.lowPriority && child.pid) {
      // Background backfills shouldn't compete with the desktop or playback.
      try {
        setPriority(child.pid, 19);
      } catch {
        // Priority is best effort.
      }
    }
    let stdout = "";
    let stderr = "";
    let failure: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const terminate = () => {
      child.kill("SIGTERM");
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), 2_000);
      killTimer.unref();
    };
    const timer = setTimeout(() => {
      failure = new Error("Preview generation timed out");
      terminate();
    }, timeoutMs);
    const pid = child.pid;
    // A pathological input must fail the job, not swap the desktop to a halt.
    const memoryWatch =
      options.maxRssBytes && pid
        ? setInterval(() => {
            readFile(`/proc/${pid}/status`, "utf8")
              .then((status) => {
                const kb = Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0);
                if (kb * 1024 > options.maxRssBytes! && !failure) {
                  failure = new Error(
                    `Preview generation exceeded ${Math.round(options.maxRssBytes! / 2 ** 20)} MB of memory`
                  );
                  terminate();
                }
              })
              .catch(() => {
                // Exited, or no procfs on this platform.
              });
          }, 250)
        : undefined;
    const cleanup = () => {
      clearTimeout(timer);
      clearInterval(memoryWatch);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", terminate);
    };
    signal?.addEventListener("abort", terminate, { once: true });
    child.stdout.on("data", (data: Buffer) => {
      if (stdout.length < 64 * 1024) stdout += data.toString();
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr = (stderr + data.toString()).slice(-4 * 1024);
    });
    child.once("error", () => {
      cleanup();
      reject(new Error(`Could not start ${command}`));
    });
    child.once("close", (code) => {
      cleanup();
      if (signal?.aborted) reject(signal.reason);
      else if (failure) reject(failure);
      else resolveRun({ code, stdout, stderr });
    });
  });
}

interface RendererOptions {
  ffmpegPath: string;
  ffprobePath: string;
  vaapiDevice?: string;
  timeoutMs?: number;
  /** Renders measured 0.7–1.6 GB, up to ~3 GB for 4K60 AV1 decoded on the CPU. */
  maxRssBytes?: number;
}

export interface PreviewRenderResult {
  sizeBytes: number;
  durationSeconds: number;
  clipCount: number;
  width: number;
  height: number;
  hasAudio: boolean;
  hardwareDecode: boolean;
}

/** Render to a private sibling first; existing files are never overwritten on failure. */
export class PreviewRenderer {
  constructor(private readonly options: RendererOptions) {}

  async render(
    input: PreviewRenderOptions,
    priority: "interactive" | "background",
    signal?: AbortSignal
  ): Promise<PreviewRenderResult> {
    if (resolve(input.inputPath) === resolve(input.outputPath))
      throw new Error("Invalid preview render target");
    const plan = planPreviewClips(input.durationSeconds, input.plan);
    return mediaWorkScheduler.run(
      priority,
      async () => {
        let lastError: unknown;
        // Metadata can claim an audio track the file lacks; retry video-only.
        for (const withAudio of input.hasAudio ? [true, false] : [false]) {
          for (const device of this.options.vaapiDevice
            ? [this.options.vaapiDevice, undefined]
            : [undefined]) {
            signal?.throwIfAborted();
            const temporary = `${input.outputPath}.${randomUUID()}.mp4`;
            try {
              const result = await runProcess(
                this.options.ffmpegPath,
                buildPreviewArguments(input, temporary, withAudio, device),
                this.options.timeoutMs ?? 10 * 60_000,
                {
                  lowPriority: priority === "background",
                  signal,
                  maxRssBytes: this.options.maxRssBytes ?? 6 * 2 ** 30,
                }
              );
              if (result.code !== 0)
                throw new Error(
                  `Preview encoder failed: ${result.stderr.trim().split("\n").pop() ?? ""}`
                );
              const probe = await this.probe(temporary, signal);
              await copyFile(
                temporary,
                input.outputPath,
                constants.COPYFILE_EXCL
              );
              return {
                sizeBytes: (await stat(input.outputPath)).size,
                durationSeconds: probe.durationSeconds,
                clipCount: plan.starts.length,
                width: probe.width,
                height: probe.height,
                hasAudio: withAudio,
                hardwareDecode: Boolean(device),
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
        throw lastError ?? new Error("Preview generation failed");
      },
      signal
    );
  }

  private async probe(path: string, signal?: AbortSignal) {
    const result = await runProcess(
      this.options.ffprobePath,
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height:format=duration",
        "-of",
        "json",
        path,
      ],
      30_000,
      { signal }
    );
    if (result.code !== 0) throw new Error("Preview output is unreadable");
    const parsed = JSON.parse(result.stdout) as {
      streams?: { width?: number; height?: number }[];
      format?: { duration?: string };
    };
    const width = parsed.streams?.[0]?.width ?? 0;
    const height = parsed.streams?.[0]?.height ?? 0;
    const durationSeconds = Number(parsed.format?.duration ?? 0);
    if (!width || !height || !(durationSeconds > 0))
      throw new Error("Preview encoder produced no video");
    return { width, height, durationSeconds };
  }
}
