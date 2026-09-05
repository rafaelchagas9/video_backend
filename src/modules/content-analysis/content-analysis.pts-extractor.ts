import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { mediaWorkScheduler } from "@/utils/media-work-scheduler";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RetryableContentAnalysisError } from "./content-analysis.store";

const DEFAULT_CHUNK_DURATION_SECONDS = 300;
const DEFAULT_SAMPLE_INTERVAL_SECONDS = 2;
const DEFAULT_MAX_FRAMES_PER_CHUNK = 512;
const DEFAULT_MAX_FRAME_DIMENSION = 640;
const MAX_WINDOWS = 1_000;
const MAX_CAPTURED_STDERR_BYTES = 8 * 1024 * 1024;
const DEFAULT_EXTRACTION_TIMEOUT_MS = 10 * 60 * 1_000;

export interface ContentAnalysisExtractionWindow {
  startSeconds: number;
  endSeconds: number;
}

export interface PtsAwareExtractionInput {
  filePath: string;
  durationSeconds: number;
  windows?: readonly ContentAnalysisExtractionWindow[];
  startChunkIndex?: number;
  chunkDurationSeconds?: number;
  sampleIntervalSeconds?: number;
  maxFramesPerChunk?: number;
  maxFrameDimension?: number;
  keyframesOnly?: boolean;
  prefetchRefinement?: {
    sampleIntervalSeconds: number;
    chunkDurationSeconds: number;
  };
}

export interface ExtractedContentAnalysisFrame {
  index: number;
  path: string;
  ptsSeconds: number;
}

export interface ExtractedContentAnalysisChunk {
  chunkIndex: number;
  startSeconds: number;
  endSeconds: number;
  frames: readonly ExtractedContentAnalysisFrame[];
  /** Additional grids from the same decode pass; owned by this chunk's lifetime. */
  prefetchedChunks?: readonly ExtractedContentAnalysisChunk[];
  /**
   * Deletes every frame in this chunk. Frame paths are invalid after this
   * resolves. Calling it more than once is safe.
   */
  dispose(): Promise<void>;
}

export interface ContentAnalysisChunkExtractor {
  /**
   * A bounded group of adjacent chunks may be materialized together. Advancing
   * disposes the previous chunk; closing removes every prefetched frame.
   */
  extract(
    input: PtsAwareExtractionInput,
    signal?: AbortSignal
  ): AsyncIterable<ExtractedContentAnalysisChunk>;
}

export interface PtsAwareChunkExtractorOptions {
  ffmpegPath: string;
  temporaryRoot?: string;
  timeoutMs?: number;
  hardwareAcceleration?:
    | {
        type: "vaapi";
        device: string;
      }
    | undefined;
  outputFormat?: "jpg" | "png";
  /** FFmpeg JPEG qscale (2 is highest quality, 31 is lowest). */
  jpegQuality?: number;
}

interface ChunkSpec {
  chunkIndex: number;
  startSeconds: number;
  endSeconds: number;
}

function abortError(): DOMException {
  return new DOMException("Content analysis was cancelled", "AbortError");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function finitePositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a finite positive number`);
  }
}

export function buildChunkSpecs(input: PtsAwareExtractionInput): ChunkSpec[] {
  finitePositive(input.durationSeconds, "durationSeconds");
  const chunkDuration =
    input.chunkDurationSeconds ?? DEFAULT_CHUNK_DURATION_SECONDS;
  finitePositive(chunkDuration, "chunkDurationSeconds");
  const windows = input.windows ?? [
    { startSeconds: 0, endSeconds: input.durationSeconds },
  ];
  if (windows.length > MAX_WINDOWS) {
    throw new Error(`windows cannot contain more than ${MAX_WINDOWS} entries`);
  }
  let previousEnd = -1;
  const specs: ChunkSpec[] = [];
  for (const window of windows) {
    if (
      !Number.isFinite(window.startSeconds) ||
      !Number.isFinite(window.endSeconds) ||
      window.startSeconds < 0 ||
      window.endSeconds <= window.startSeconds ||
      window.endSeconds > input.durationSeconds ||
      window.startSeconds < previousEnd
    ) {
      throw new Error(
        "windows must be finite, sorted, non-overlapping, and inside the source duration"
      );
    }
    previousEnd = window.endSeconds;
    const chunkCount = Math.ceil(
      (window.endSeconds - window.startSeconds) / chunkDuration - 1e-12
    );
    for (let index = 0; index < chunkCount; index += 1) {
      const startSeconds = window.startSeconds + index * chunkDuration;
      specs.push({
        chunkIndex: specs.length,
        startSeconds,
        endSeconds: Math.min(startSeconds + chunkDuration, window.endSeconds),
      });
    }
  }
  return specs;
}

function parsePts(stderr: string): number[] {
  const values: number[] = [];
  const pattern =
    /showinfo[^\n]*\bn:\s*\d+[^\n]*\bpts_time:\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)/gi;
  for (const match of stderr.matchAll(pattern)) {
    const value = Number(match[1]);
    if (!Number.isFinite(value) || value < 0) {
      throw new Error("Frame extraction returned an invalid timestamp");
    }
    values.push(value);
  }
  return values;
}

async function runFfmpeg(
  ffmpegPath: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal
): Promise<string> {
  throwIfAborted(signal);
  return new Promise<string>((resolve, reject) => {
    const child = spawn(ffmpegPath, args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    const stderr: Buffer[] = [];
    let stderrBytes = 0;
    let settled = false;
    let aborted = false;
    let forcedError: Error | null = null;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (killTimer) clearTimeout(killTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      callback();
    };
    const terminate = (): void => {
      child.kill("SIGTERM");
      if (!killTimer) {
        killTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
        killTimer.unref?.();
      }
    };
    const onAbort = (): void => {
      if (aborted) return;
      aborted = true;
      terminate();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    timeoutTimer = setTimeout(() => {
      if (settled || aborted) return;
      forcedError = new RetryableContentAnalysisError(
        "FRAME_EXTRACTION_TIMEOUT",
        "Frame extraction timed out"
      );
      terminate();
    }, timeoutMs);
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_CAPTURED_STDERR_BYTES && !forcedError) {
        forcedError = new Error("Frame extraction failed");
        terminate();
        return;
      }
      if (!forcedError) stderr.push(chunk);
    });
    child.once("error", () => {
      finish(() =>
        reject(
          aborted
            ? abortError()
            : (forcedError ?? new Error("Frame extraction failed"))
        )
      );
    });
    child.once("close", (code) => {
      finish(() => {
        if (aborted) {
          reject(abortError());
          return;
        }
        if (forcedError) {
          reject(forcedError);
          return;
        }
        if (code !== 0) {
          reject(new Error("Frame extraction failed"));
          return;
        }
        resolve(Buffer.concat(stderr).toString("utf8"));
      });
    });
  });
}

export class PtsAwareChunkExtractor implements ContentAnalysisChunkExtractor {
  constructor(private readonly options: PtsAwareChunkExtractorOptions) {}

  async *extract(
    input: PtsAwareExtractionInput,
    signal?: AbortSignal
  ): AsyncGenerator<ExtractedContentAnalysisChunk> {
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_EXTRACTION_TIMEOUT_MS;
    finitePositive(timeoutMs, "timeoutMs");
    const sampleInterval =
      input.sampleIntervalSeconds ?? DEFAULT_SAMPLE_INTERVAL_SECONDS;
    finitePositive(sampleInterval, "sampleIntervalSeconds");
    const maxFrames = input.maxFramesPerChunk ?? DEFAULT_MAX_FRAMES_PER_CHUNK;
    if (!Number.isInteger(maxFrames) || maxFrames < 1 || maxFrames > 4_096) {
      throw new Error(
        "maxFramesPerChunk must be an integer between 1 and 4096"
      );
    }
    const maxFrameDimension =
      input.maxFrameDimension ?? DEFAULT_MAX_FRAME_DIMENSION;
    if (
      !Number.isInteger(maxFrameDimension) ||
      maxFrameDimension < 64 ||
      maxFrameDimension > 4_096
    ) {
      throw new Error(
        "maxFrameDimension must be an integer between 64 and 4096"
      );
    }
    const startChunkIndex = input.startChunkIndex ?? 0;
    if (!Number.isInteger(startChunkIndex) || startChunkIndex < 0) {
      throw new Error("startChunkIndex must be a non-negative integer");
    }
    const specs = buildChunkSpecs(input).slice(startChunkIndex);
    if (input.prefetchRefinement) {
      finitePositive(
        input.prefetchRefinement.sampleIntervalSeconds,
        "refinement sample interval"
      );
      finitePositive(
        input.prefetchRefinement.chunkDurationSeconds,
        "refinement chunk duration"
      );
    }
    // Hardware decode failures (unsupported codec/profile, device issues)
    // disable the accelerated path for the rest of this extraction session so
    // every remaining chunk is not attempted twice.
    const hardwareState = {
      enabled: this.options.hardwareAcceleration !== undefined,
    };
    throwIfAborted(signal);
    const sessionRoot = await mkdtemp(
      join(this.options.temporaryRoot ?? tmpdir(), "content-analysis-")
    );
    let currentChunk: ExtractedContentAnalysisChunk | null = null;
    try {
      for (const spec of specs) {
        throwIfAborted(signal);
        await currentChunk?.dispose();
        currentChunk = await this.extractChunk(
          sessionRoot,
          input.filePath,
          spec,
          sampleInterval,
          input.keyframesOnly ?? false,
          maxFrames,
          maxFrameDimension,
          timeoutMs,
          hardwareState,
          signal,
          input.keyframesOnly ? undefined : input.prefetchRefinement
        );
        yield currentChunk;
      }
    } finally {
      await currentChunk?.dispose();
      await rm(sessionRoot, { recursive: true, force: true });
    }
  }

  private buildChunkArguments(
    filePath: string,
    outputPattern: string,
    outputFormat: "jpg" | "png",
    jpegQuality: number,
    spec: ChunkSpec,
    sampleInterval: number,
    keyframesOnly: boolean,
    maxFrames: number,
    maxFrameDimension: number,
    useHardware: boolean,
    prefetch?: {
      sampleIntervalSeconds: number;
      resetAtSeconds: number[];
      outputPattern: string;
      maxFrames: number;
    }
  ): string[] {
    // `-t` is enforced by the output muxer, after filters have run. Bound the
    // select expression too, otherwise showinfo can report the first frame of
    // the next chunk even though no corresponding image was emitted.
    const selectionFor = (
      interval: number,
      resets: readonly number[],
      name = ""
    ) =>
      `select='gte(t\\,${spec.startSeconds})*lt(t\\,${spec.endSeconds})*` +
      `(isnan(prev_selected_t)+gte(t-prev_selected_t\\,${interval})` +
      resets
        .map((start) => `+gte(t\\,${start})*lt(prev_selected_t\\,${start})`)
        .join("") +
      `)',` +
      // Record the source PTS first, then reset only the encoder-facing PTS
      // so a later absolute chunk is not discarded by the output duration.
      `showinfo${name},setpts=PTS-STARTPTS,` +
      // With hardware decode, frames stay on the GPU through select so only
      // the sampled frames are scaled and downloaded, instead of paying a
      // GPU-to-CPU readback for every decoded frame in the chunk.
      (useHardware
        ? `scale_vaapi=w='min(${maxFrameDimension}\\,iw)':` +
          `h='min(${maxFrameDimension}\\,ih)':force_original_aspect_ratio=decrease,` +
          "hwdownload,format=nv12"
        : `scale=w='min(${maxFrameDimension}\\,iw)':` +
          `h='min(${maxFrameDimension}\\,ih)':force_original_aspect_ratio=decrease`);
    const hardwareAcceleration = this.options.hardwareAcceleration;
    const inputOptions = [
      ...(useHardware && hardwareAcceleration
        ? [
            "-hwaccel",
            hardwareAcceleration.type,
            "-hwaccel_device",
            hardwareAcceleration.device,
            "-hwaccel_output_format",
            hardwareAcceleration.type,
          ]
        : []),
      ...(keyframesOnly ? ["-skip_frame", "nokey"] : []),
    ];
    const encodingOptions =
      outputFormat === "jpg"
        ? [
            "-qscale:v",
            String(jpegQuality),
            // The MJPEG encoder otherwise fails to initialize when a valid
            // bounded window contains no selected frames.
            "-strict",
            "unofficial",
          ]
        : ["-compression_level", "3"];
    const outputOptions = (limit: number) => [
      "-an",
      "-fps_mode",
      "passthrough",
      "-frames:v",
      String(limit + 1),
      "-start_number",
      "0",
      ...encodingOptions,
    ];
    const selection = selectionFor(
      sampleInterval,
      [],
      prefetch ? "@coarse" : ""
    );
    const outputArguments = prefetch
      ? [
          "-filter_complex",
          `[0:v:0]split=2[coarse][dense];[coarse]${selection}[coarseout];` +
            `[dense]${selectionFor(prefetch.sampleIntervalSeconds, prefetch.resetAtSeconds, "@refinement")}[denseout]`,
          "-map",
          "[coarseout]",
          ...outputOptions(maxFrames),
          outputPattern,
          "-map",
          "[denseout]",
          ...outputOptions(prefetch.maxFrames),
          prefetch.outputPattern,
        ]
      : ["-vf", selection, ...outputOptions(maxFrames), outputPattern];
    return [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "info",
      "-copyts",
      "-start_at_zero",
      ...inputOptions,
      "-ss",
      String(spec.startSeconds),
      // Input-side duration is essential: an output-side `-t` would wait
      // forever for a timestamp beyond the last frame admitted by select.
      "-t",
      String(spec.endSeconds - spec.startSeconds),
      "-i",
      filePath,
      ...outputArguments,
    ];
  }

  private async extractChunk(
    sessionRoot: string,
    filePath: string,
    spec: ChunkSpec,
    sampleInterval: number,
    keyframesOnly: boolean,
    maxFrames: number,
    maxFrameDimension: number,
    timeoutMs: number,
    hardwareState: { enabled: boolean },
    signal?: AbortSignal,
    prefetchRefinement?: PtsAwareExtractionInput["prefetchRefinement"]
  ): Promise<ExtractedContentAnalysisChunk> {
    const chunkRoot = join(sessionRoot, `chunk-${spec.chunkIndex}`);
    await mkdir(chunkRoot);
    let disposed = false;
    const dispose = async (): Promise<void> => {
      if (disposed) return;
      disposed = true;
      await rm(chunkRoot, { recursive: true, force: true });
    };
    try {
      const outputFormat = this.options.outputFormat ?? "jpg";
      const jpegQuality = this.options.jpegQuality ?? 5;
      if (
        outputFormat === "jpg" &&
        (!Number.isInteger(jpegQuality) || jpegQuality < 2 || jpegQuality > 31)
      ) {
        throw new Error("jpegQuality must be an integer between 2 and 31");
      }
      const outputPattern = join(chunkRoot, `frame-%06d.${outputFormat}`);
      const prefetchSpecs = prefetchRefinement
        ? buildChunkSpecs({
            filePath,
            durationSeconds: spec.endSeconds,
            windows: [
              { startSeconds: spec.startSeconds, endSeconds: spec.endSeconds },
            ],
            chunkDurationSeconds: prefetchRefinement.chunkDurationSeconds,
          })
        : [];
      const prefetchLimit = prefetchRefinement
        ? Math.ceil(
            (spec.endSeconds - spec.startSeconds) /
              prefetchRefinement.sampleIntervalSeconds
          ) + prefetchSpecs.length
        : 0;
      const prefetch =
        prefetchRefinement && prefetchLimit <= 4_096
          ? {
              sampleIntervalSeconds: prefetchRefinement.sampleIntervalSeconds,
              resetAtSeconds: prefetchSpecs
                .slice(1)
                .map((part) => part.startSeconds),
              outputPattern: join(chunkRoot, `dense-%06d.${outputFormat}`),
              maxFrames: prefetchLimit,
            }
          : undefined;
      const runAttempt = (useHardware: boolean): Promise<string> =>
        mediaWorkScheduler.run(
          "analysis",
          () =>
            runFfmpeg(
              this.options.ffmpegPath,
              this.buildChunkArguments(
                filePath,
                outputPattern,
                outputFormat,
                jpegQuality,
                spec,
                sampleInterval,
                keyframesOnly,
                maxFrames,
                maxFrameDimension,
                useHardware,
                prefetch
              ),
              timeoutMs,
              signal
            ),
          signal
        );
      let stderr: string;
      try {
        stderr = await runAttempt(hardwareState.enabled);
      } catch (error) {
        if (
          !hardwareState.enabled ||
          error instanceof RetryableContentAnalysisError ||
          (error instanceof DOMException && error.name === "AbortError")
        ) {
          throw error;
        }
        hardwareState.enabled = false;
        await rm(chunkRoot, { recursive: true, force: true });
        await mkdir(chunkRoot);
        stderr = await runAttempt(false);
      }
      throwIfAborted(signal);
      const pts = parsePts(
        prefetch
          ? stderr
              .split("\n")
              .filter((line) => line.includes("showinfo@coarse"))
              .join("\n")
          : stderr
      );
      const outputPatternMatcher = new RegExp(
        `^frame-\\d{6}\\.${outputFormat}$`
      );
      const files = (await readdir(chunkRoot))
        .filter((name) => outputPatternMatcher.test(name))
        .sort();
      if (files.length !== pts.length) {
        throw new Error("Frame extraction timestamp correlation failed");
      }
      if (files.length > maxFrames) {
        throw new Error("Frame extraction exceeded the bounded chunk limit");
      }
      const prefetchedChunks: ExtractedContentAnalysisChunk[] = [];
      if (prefetch) {
        const densePts = parsePts(
          stderr
            .split("\n")
            .filter((line) => line.includes("showinfo@refinement"))
            .join("\n")
        );
        const denseFiles = (await readdir(chunkRoot))
          .filter((name) =>
            new RegExp(`^dense-\\d{6}\\.${outputFormat}$`).test(name)
          )
          .sort();
        if (denseFiles.length !== densePts.length)
          throw new Error("Frame extraction timestamp correlation failed");
        if (denseFiles.length > prefetch.maxFrames)
          throw new Error("Frame extraction exceeded the bounded chunk limit");
        for (const part of prefetchSpecs) {
          const frames = denseFiles
            .map((name, index) => ({
              index,
              path: join(chunkRoot, name),
              ptsSeconds: densePts[index]!,
            }))
            .filter(
              (frame) =>
                frame.ptsSeconds >= part.startSeconds &&
                frame.ptsSeconds < part.endSeconds
            )
            .map((frame, index) => ({ ...frame, index }));
          prefetchedChunks.push({
            ...part,
            frames,
            async dispose() {
              await Promise.all(
                frames.map((frame) => rm(frame.path, { force: true }))
              );
            },
          });
        }
      }
      return {
        chunkIndex: spec.chunkIndex,
        startSeconds: spec.startSeconds,
        endSeconds: spec.endSeconds,
        frames: files.map((name, index) => ({
          index,
          path: join(chunkRoot, name),
          ptsSeconds: pts[index]!,
        })),
        ...(prefetch ? { prefetchedChunks } : {}),
        dispose,
      };
    } catch (error) {
      await dispose();
      if (error instanceof RetryableContentAnalysisError) throw error;
      if (error instanceof DOMException && error.name === "AbortError") {
        throw error;
      }
      if (
        error instanceof Error &&
        (error.message === "Frame extraction timestamp correlation failed" ||
          error.message ===
            "Frame extraction exceeded the bounded chunk limit" ||
          error.message === "Frame extraction returned an invalid timestamp")
      ) {
        throw error;
      }
      throw new Error("Frame extraction failed");
    }
  }
}
