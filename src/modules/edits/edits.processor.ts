import { existsSync } from "fs";
import { link, mkdir, realpath, unlink } from "fs/promises";
import { isAbsolute, join, relative } from "path";
import { spawn, type ChildProcess } from "child_process";
import { editsService, resolveSafeOutputTarget } from "./edits.service";
import {
  calculateExpectedDuration,
  validateEditRequest,
} from "./edits.validation";
import { editsQueue } from "./edits.queue";
import { videosService } from "@/modules/videos/videos.service";
import { thumbnailsService } from "@/modules/thumbnails/thumbnails.service";
import {
  classifyFfmpegFailure,
  ffmpegService,
} from "@/modules/conversion/conversion.ffmpeg.service";
import { gpuModes } from "@/utils/gpu-modes";
import { logger } from "@/utils/logger";
import { usesVaapi } from "@/utils/media-process";
import { recordPerfStage } from "@/utils/performance-profiler";
import { env } from "@/config/env";
import { ConflictError } from "@/utils/errors";
import { captureTelemetryException } from "@/utils/telemetry";
import type {
  EditOutputConfig,
  EditQueuePayload,
  EditTimelineConfig,
  EditTransformConfig,
} from "./edits.types";
import type { Video } from "@/modules/videos/videos.types";
import {
  probeRenderedEditOutput,
  RenderedEditValidationError,
} from "./edits.render-validation";

export { calculateExpectedDuration } from "./edits.validation";

export class EditCancelledError extends Error {
  readonly name = "EditCancelledError";

  constructor(message = "Edit job was cancelled") {
    super(message);
    Object.setPrototypeOf(this, EditCancelledError.prototype);
  }
}

class EditFfmpegProcessError extends Error {
  readonly name = "EditFfmpegProcessError";

  constructor(
    message: string,
    readonly stderrOutput: string,
    readonly exitCode: number | null,
    readonly signal: NodeJS.Signals | null,
    readonly encodingMode: EditEncodingMode,
    options?: ErrorOptions
  ) {
    super(message, options);
    Object.setPrototypeOf(this, EditFfmpegProcessError.prototype);
  }
}

function shouldRetryWithSoftwareDecode(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const stderr =
    error instanceof EditFfmpegProcessError ? error.stderrOutput : "";
  const output = `${error.message}\n${stderr}`.toLowerCase();
  return (
    output.includes("reconfiguring filter graph because hwaccel changed") ||
    output.includes(
      "reconfiguring filter graph because video parameters changed"
    ) ||
    output.includes("impossible to convert between the formats") ||
    output.includes("error reinitializing filters") ||
    output.includes("failed setup for format vaapi") ||
    output.includes("hwaccel initialisation returned error") ||
    output.includes("hardware accelerator failed to decode") ||
    output.includes("failed to get number of surface attributes") ||
    output.includes("no support for codec")
  );
}

const EDIT_FFMPEG_STALL_MS = 3 * 60_000;

function formatNumber(value: number): string {
  return Number(value.toFixed(6)).toString();
}

export function buildAtempoChain(speed: number): string[] {
  if (speed === 1) return [];

  const filters: string[] = [];
  let remaining = speed;
  if (speed > 1) {
    while (remaining > 2) {
      filters.push("atempo=2");
      remaining /= 2;
    }
  } else {
    while (remaining < 0.5) {
      filters.push("atempo=0.5");
      remaining /= 0.5;
    }
  }
  if (Math.abs(remaining - 1) > 0.000001) {
    filters.push(`atempo=${formatNumber(remaining)}`);
  }
  return filters;
}

export interface EditFilterGraph {
  filterComplex: string;
  videoOutputLabel: "[vout]";
  audioOutputLabel: "[aout]" | null;
}

export type EditEncodingMode = "hw" | "sw_decode";

export interface BuildEditFilterComplexOptions {
  sourceWidth?: number | null;
  sourceHeight?: number | null;
  sourceFps?: number | null;
  segmentDimensions?: ReadonlyArray<{ width: number; height: number } | null>;
  encodingMode?: EditEncodingMode;
}

function buildCropFilter(
  crop: NonNullable<EditTransformConfig["crop"]>
): string {
  return `crop=w=max(2\\,trunc(iw*${formatNumber(crop.width)}/2)*2):h=max(2\\,trunc(ih*${formatNumber(crop.height)}/2)*2):x=min(trunc(iw*${formatNumber(crop.x)}/2)*2\\,iw-ow):y=min(trunc(ih*${formatNumber(crop.y)}/2)*2\\,ih-oh)`;
}

function buildRotationFilters(rotate: EditTransformConfig["rotate"]): string[] {
  if (rotate === 90) return ["transpose=clock"];
  if (rotate === 180) return ["hflip", "vflip"];
  if (rotate === 270) return ["transpose=cclock"];
  return [];
}

function evenDimension(
  value: number | null | undefined,
  fallback: number
): number {
  const dimension =
    typeof value === "number" && Number.isFinite(value) && value > 0
      ? value
      : fallback;
  return Math.max(2, Math.floor(dimension / 2) * 2);
}

/** probeSegmentDimensions reports a segment whose frames change size as 0x0. */
function hasMixedSizes(
  dimensions: { width: number; height: number } | null | undefined
): boolean {
  return dimensions?.width === 0;
}

/** Build a deterministic filter graph without touching FFmpeg or the filesystem. */
export function buildEditFilterComplex(
  timeline: EditTimelineConfig,
  hasSourceAudio: boolean,
  options: BuildEditFilterComplexOptions = {}
): EditFilterGraph {
  const filters: string[] = [];
  const includeAudio = hasSourceAudio && timeline.audio?.muted !== true;
  const hardwareDecode = (options.encodingMode ?? "hw") === "hw";
  const concatInputs: string[] = [];
  const segments = timeline.segments;
  const canvasWidth = evenDimension(options.sourceWidth, 1920);
  const canvasHeight = evenDimension(options.sourceHeight, 1080);
  const sizeDiffersFromCanvas = (index: number): boolean => {
    const dimensions = options.segmentDimensions?.[index];
    return (
      !!dimensions &&
      (dimensions.width !== canvasWidth || dimensions.height !== canvasHeight)
    );
  };
  const normalizeSegments = segments.some(
    (segment, index) =>
      segment.transform?.crop !== undefined ||
      (segment.transform?.rotate ?? 0) !== 0 ||
      sizeDiffersFromCanvas(index)
  );
  const sourceFps =
    options.sourceFps && options.sourceFps > 0 && options.sourceFps <= 240
      ? options.sourceFps
      : null;

  segments.forEach((segment, index) => {
    const videoInput = includeAudio ? index * 2 : index;
    const speed = segment.speed ?? 1;
    const sourceDuration = segment.end - segment.start;
    // Input seeking already rebases timestamps to the segment start. fps pads a
    // source video dropout at the cut with the first frame (instead of letting
    // PTS-STARTPTS slide the clip earlier than its audio), then trim is applied
    // so the segment is exactly the requested length.
    const setpts =
      speed === 1
        ? "setpts=PTS-STARTPTS"
        : `setpts=(PTS-STARTPTS)/${formatNumber(speed)}`;
    const alignStart =
      sourceFps !== null
        ? `fps=fps=${formatNumber(sourceFps)}:start_time=0:round=near,`
        : "";
    let segmentInput = `[${videoInput}:v]${alignStart}`;
    if (hasMixedSizes(options.segmentDimensions?.[index])) {
      // The input runs with -reinit_filter 0, so frames change size inside the
      // graph. Only per-frame scale and overlay follow that; pad keeps its first
      // size and fills the rest with garbage. Rebuilding the graph instead
      // deadlocks the concat, so fit every frame onto a fixed canvas here.
      const fps = formatNumber(sourceFps ?? 30);
      filters.push(
        `[${videoInput}:v]fps=fps=${fps}:start_time=0:round=near,scale=w=${canvasWidth}:h=${canvasHeight}:force_original_aspect_ratio=decrease:force_divisible_by=2:eval=frame[vfit${index}]`,
        `color=c=black:s=${canvasWidth}x${canvasHeight}:r=${fps}[vcanvas${index}]`
      );
      segmentInput = `[vcanvas${index}][vfit${index}]overlay=x=(W-w)/2:y=(H-h)/2:eval=frame:shortest=1,`;
    }
    filters.push(
      `${segmentInput}trim=duration=${formatNumber(sourceDuration)},${setpts}[v${index}]`
    );

    let videoLabel = `[v${index}]`;
    if (normalizeSegments) {
      const segmentVideoFilters: string[] = [];
      if (hardwareDecode) {
        segmentVideoFilters.push("hwdownload", "format=nv12");
      }
      if (segment.transform?.crop) {
        segmentVideoFilters.push(buildCropFilter(segment.transform.crop));
      }
      segmentVideoFilters.push(
        ...buildRotationFilters(segment.transform?.rotate),
        `scale=w=${canvasWidth}:h=${canvasHeight}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
        `pad=w=${canvasWidth}:h=${canvasHeight}:x=(ow-iw)/2:y=(oh-ih)/2:color=black`,
        "setsar=1",
        "settb=AVTB",
        "format=yuv420p"
      );
      filters.push(
        `${videoLabel}${segmentVideoFilters.join(",")}[vsegment${index}]`
      );
      videoLabel = `[vsegment${index}]`;
    }

    if (includeAudio) {
      const segmentDuration = sourceDuration / speed;
      const audioFilters = [
        `[${videoInput + 1}:a]atrim=duration=${formatNumber(sourceDuration)}`,
        "asetpts=PTS-STARTPTS",
        ...buildAtempoChain(speed),
        `apad=whole_dur=${formatNumber(segmentDuration)}`,
        `atrim=duration=${formatNumber(segmentDuration)}`,
        "asetpts=PTS-STARTPTS",
      ];
      const segmentAudioFilters: string[] = [];
      const segmentAudio = segment.audio;
      const volume = segmentAudio?.muted ? 0 : (segmentAudio?.volume ?? 1);
      if (volume !== 1) {
        segmentAudioFilters.push(`volume=${formatNumber(volume)}`);
      }
      const fadeIn = segmentAudio?.fade_in_seconds ?? 0;
      if (fadeIn > 0) {
        segmentAudioFilters.push(`afade=t=in:st=0:d=${formatNumber(fadeIn)}`);
      }
      const fadeOut = segmentAudio?.fade_out_seconds ?? 0;
      if (fadeOut > 0) {
        const start = Math.max(0, segmentDuration - fadeOut);
        segmentAudioFilters.push(
          `afade=t=out:st=${formatNumber(start)}:d=${formatNumber(fadeOut)}`
        );
      }
      audioFilters.push(...segmentAudioFilters);
      filters.push(`${audioFilters.join(",")}[asegment${index}]`);
      concatInputs.push(`${videoLabel}[asegment${index}]`);
    } else {
      concatInputs.push(videoLabel);
    }
  });

  if (includeAudio) {
    filters.push(
      `${concatInputs.join("")}concat=n=${timeline.segments.length}:v=1:a=1[vconcat][aconcat]`
    );
  } else {
    filters.push(
      `${concatInputs.join("")}concat=n=${timeline.segments.length}:v=1:a=0[vconcat]`
    );
  }

  const videoFilters: string[] = [];
  const crop = timeline.transform?.crop;
  const globalSpatialFilters =
    crop !== undefined || (timeline.transform?.rotate ?? 0) !== 0;
  const concatOutputIsHardware = hardwareDecode && !normalizeSegments;
  if (globalSpatialFilters && concatOutputIsHardware) {
    videoFilters.push("hwdownload", "format=nv12");
  }
  if (crop) {
    videoFilters.push(buildCropFilter(crop));
  }
  const rotate = timeline.transform?.rotate ?? 0;
  videoFilters.push(...buildRotationFilters(rotate));
  if (!concatOutputIsHardware || globalSpatialFilters) {
    videoFilters.push("format=nv12", "hwupload");
  }
  filters.push(
    `[vconcat]${videoFilters.length > 0 ? videoFilters.join(",") : "null"}[vout]`
  );

  if (includeAudio) {
    const expectedDuration = calculateExpectedDuration(timeline);
    const audioFilters: string[] = [
      `apad=whole_dur=${formatNumber(expectedDuration)}`,
      `atrim=duration=${formatNumber(expectedDuration)}`,
      "asetpts=PTS-STARTPTS",
    ];
    const volume = timeline.audio?.volume ?? 1;
    if (volume !== 1) audioFilters.push(`volume=${formatNumber(volume)}`);
    const fadeIn = timeline.audio?.fade_in_seconds ?? 0;
    if (fadeIn > 0) {
      audioFilters.push(`afade=t=in:st=0:d=${formatNumber(fadeIn)}`);
    }
    const fadeOut = timeline.audio?.fade_out_seconds ?? 0;
    if (fadeOut > 0) {
      const start = Math.max(0, expectedDuration - fadeOut);
      audioFilters.push(
        `afade=t=out:st=${formatNumber(start)}:d=${formatNumber(fadeOut)}`
      );
    }
    filters.push(
      `[aconcat]${audioFilters.length > 0 ? audioFilters.join(",") : "anull"}[aout]`
    );
  }

  return {
    filterComplex: filters.join(";"),
    videoOutputLabel: "[vout]",
    audioOutputLabel: includeAudio ? "[aout]" : null,
  };
}

export interface BuildEditFfmpegArgsOptions {
  inputPath: string;
  /** One input per segment for a multi-source timeline; `inputPath` otherwise. */
  inputPaths?: readonly string[];
  outputPath: string;
  timeline: EditTimelineConfig;
  output: EditOutputConfig;
  hasSourceAudio: boolean;
  sourceWidth?: number | null;
  sourceHeight?: number | null;
  sourceFps?: number | null;
  segmentDimensions?: BuildEditFilterComplexOptions["segmentDimensions"];
  vaapiDevice: string;
  bitrate: string;
  maxrate: string;
  bufsize: string;
  encodingMode?: EditEncodingMode;
}

export function buildEditFfmpegArgs(
  options: BuildEditFfmpegArgsOptions
): string[] {
  const encodingMode = options.encodingMode ?? "hw";
  const graph = buildEditFilterComplex(
    options.timeline,
    options.hasSourceAudio,
    {
      sourceWidth: options.sourceWidth,
      sourceHeight: options.sourceHeight,
      sourceFps: options.sourceFps,
      segmentDimensions: options.segmentDimensions,
      encodingMode,
    }
  );
  const args: string[] = ["-init_hw_device", `vaapi=va:${options.vaapiDevice}`];
  if (encodingMode === "sw_decode") {
    args.push("-threads", "0");
  }
  options.timeline.segments.forEach((segment, index) => {
    const inputPath = options.inputPaths?.[index] ?? options.inputPath;
    if (encodingMode === "hw") {
      args.push(
        "-hwaccel",
        "vaapi",
        "-hwaccel_device",
        "va",
        "-hwaccel_output_format",
        "vaapi"
      );
    }
    if (hasMixedSizes(options.segmentDimensions?.[index])) {
      args.push("-reinit_filter", "0");
    }
    args.push(
      "-ss",
      formatNumber(segment.start),
      "-t",
      formatNumber(segment.end - segment.start),
      "-an",
      "-i",
      inputPath
    );
    if (graph.audioOutputLabel) {
      // Separate demuxers keep fast audio reads from filling the video decoder's
      // overflow queue. FFmpeg 9.0.1 can silently turn that overflow into EOF.
      args.push(
        "-ss",
        formatNumber(segment.start),
        "-t",
        formatNumber(segment.end - segment.start),
        "-vn",
        "-i",
        inputPath
      );
    }
  });
  args.push(
    "-filter_hw_device",
    "va",
    "-filter_complex",
    graph.filterComplex,
    "-map",
    graph.videoOutputLabel
  );

  if (graph.audioOutputLabel) {
    args.push("-map", graph.audioOutputLabel);
  }
  args.push(
    "-fps_mode:v",
    "passthrough",
    "-enc_time_base:v",
    "filter",
    "-c:v",
    "av1_vaapi",
    "-async_depth",
    "64",
    "-rc_mode",
    "VBR",
    "-b:v",
    options.bitrate,
    "-maxrate",
    options.maxrate,
    "-bufsize",
    options.bufsize,
    "-global_quality:v",
    "34"
  );

  if (graph.audioOutputLabel) {
    if (options.output.audio_codec === "opus") {
      args.push("-c:a", "libopus", "-b:a", "96k", "-vbr", "on");
    } else {
      args.push("-c:a", "aac", "-b:a", "128k");
    }
  }
  args.push(
    "-y",
    "-progress",
    "pipe:1",
    "-nostats",
    "-f",
    "matroska",
    options.outputPath
  );
  return args;
}

interface EditInputs {
  /** The file each segment is cut from. */
  paths: string[];
  /** Durations of every video the timeline names, by id. */
  durations: Map<number, number | null>;
  /** Every file the timeline cuts from has audio. */
  hasAudio: boolean;
}

async function resolveEditInputs(
  sourceVideo: Video,
  timeline: EditTimelineConfig
): Promise<EditInputs> {
  const videos = new Map<number, Video>([[sourceVideo.id, sourceVideo]]);
  for (const segment of timeline.segments) {
    const id = segment.source_video_id;
    if (id !== undefined && !videos.has(id))
      videos.set(id, await videosService.findById(id));
  }
  const used = timeline.segments.map(
    (segment) => videos.get(segment.source_video_id ?? sourceVideo.id)!
  );
  return {
    paths: used.map((video) => video.file_path),
    durations: new Map(
      [...videos].map(([id, video]) => [id, video.duration_seconds])
    ),
    hasAudio: used.every((video) => video.audio_codec !== null),
  };
}

async function probeSegmentDimensions(
  inputPaths: readonly string[],
  timeline: EditTimelineConfig,
  signal: AbortSignal
): Promise<Array<{ width: number; height: number } | null>> {
  return Promise.all(
    timeline.segments.map(
      (segment, index) =>
        new Promise<{ width: number; height: number } | null>((resolve) => {
          const child = spawn(
            env.FFPROBE_PATH,
            [
              "-v",
              "error",
              "-select_streams",
              "v:0",
              "-skip_frame",
              "nokey",
              "-read_intervals",
              `${formatNumber(segment.start)}%${formatNumber(segment.end)}`,
              "-show_entries",
              "frame=width,height",
              "-of",
              "csv=p=0",
              inputPaths[index]!,
            ],
            { stdio: ["ignore", "pipe", "ignore"], signal }
          );
          let out = "";
          child.stdout.on("data", (chunk: Buffer) => {
            out += chunk.toString();
          });
          child.on("error", () => resolve(null));
          child.on("close", () => {
            const sizes = new Set(
              out
                .trim()
                .split(/\r?\n/)
                .map((line) => line.split(",").slice(0, 2).join("x"))
                .filter((size) => /^\d+x\d+$/.test(size))
            );
            if (sizes.size === 0) return resolve(null);
            // A mid-segment resolution change reaches the concat filter as
            // mismatched frames, so report it as a size no canvas can match.
            if (sizes.size > 1) return resolve({ width: 0, height: 0 });
            const [width, height] = [...sizes][0]!.split("x").map(Number);
            resolve({ width: width!, height: height! });
          });
        })
    )
  );
}

function terminateProcess(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null || child.killed) return;
  child.kill("SIGTERM");
  const forceKill = setTimeout(() => {
    if (child.exitCode !== null) return;
    child.kill("SIGKILL");
  }, 5_000);
  forceKill.unref();
}

async function removeIfPresent(path: string | null): Promise<void> {
  if (!path) return;
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function recordStageSafely(
  context: Parameters<typeof recordPerfStage>[0],
  stage: string,
  durationMs: number,
  metadata: Record<string, unknown>
): Promise<void> {
  try {
    await recordPerfStage(context, stage, durationMs, metadata);
  } catch (error) {
    logger.warn({ error, stage }, "Failed to record edit performance stage");
  }
}

export class EditsProcessor {
  constructor() {
    editsQueue.setProcessor(this.processJob.bind(this));
    editsQueue.setRecoveryProvider(
      editsService.recoverableQueuePayloads.bind(editsService)
    );
  }

  async processJob(
    payload: EditQueuePayload,
    signal: AbortSignal = new AbortController().signal
  ): Promise<void> {
    const { jobId, videoId, outputConfig, timelineConfig } = payload;
    const totalStart = Date.now();
    let tempOutputPath: string | null = null;
    let finalOutputPath: string | null = null;
    let registeredVideoId: number | null = null;
    let publishedByThisJob = false;
    let completed = false;

    if (!(await editsService.claimForProcessing(jobId))) {
      logger.info({ jobId }, "Skipping edit job that is no longer queued");
      return;
    }
    logger.info({ jobId }, "Starting edit job processing");

    try {
      if (signal.aborted) throw new EditCancelledError();
      const sourceVideo = await videosService.findById(videoId);
      const inputs = await resolveEditInputs(sourceVideo, timelineConfig);
      validateEditRequest(
        { output: outputConfig, timeline: timelineConfig },
        sourceVideo.duration_seconds,
        inputs.durations
      );
      for (const path of new Set(inputs.paths)) {
        if (!existsSync(path)) throw new Error(`Source file not found: ${path}`);
      }

      const prepareStart = Date.now();
      const target = await resolveSafeOutputTarget(outputConfig);
      finalOutputPath = target.finalPath;
      await mkdir(target.tempDirectoryPath, { recursive: true });
      const resolvedTempDirectory = await realpath(target.tempDirectoryPath);
      const relativeTempDirectory = relative(
        target.directoryPath,
        resolvedTempDirectory
      );
      if (
        relativeTempDirectory.startsWith("..") ||
        isAbsolute(relativeTempDirectory)
      ) {
        throw new Error(
          "Edit temporary directory escapes the output directory"
        );
      }
      tempOutputPath = join(
        resolvedTempDirectory,
        `edit_${jobId}_${target.fileName}`
      );
      await removeIfPresent(tempOutputPath);
      await recordStageSafely(
        { scenario: "editing", videoId, jobId, mode: "process_job" },
        "prepare_paths",
        Date.now() - prepareStart,
        { segmentCount: timelineConfig.segments.length }
      );

      const ffmpegStart = Date.now();
      const validateOutput = () =>
        probeRenderedEditOutput(
          tempOutputPath!,
          calculateExpectedDuration(timelineConfig),
          inputs.hasAudio && timelineConfig.audio?.muted !== true,
          signal,
          { path: inputs.paths, timeline: timelineConfig }
        );
      await this.runFfmpeg(
        jobId,
        sourceVideo,
        inputs,
        tempOutputPath,
        outputConfig,
        timelineConfig,
        signal
      );
      await recordStageSafely(
        { scenario: "editing", videoId, jobId, mode: "process_job" },
        "ffmpeg_encode",
        Date.now() - ffmpegStart,
        { segmentCount: timelineConfig.segments.length }
      );

      if (signal.aborted) throw new EditCancelledError();
      const validationStart = Date.now();
      let renderedDurations: Awaited<ReturnType<typeof validateOutput>>;
      try {
        renderedDurations = await validateOutput();
      } catch (error) {
        // Hardware decode can drop frames silently; a software-decode render
        // of the same timeline is the only way to tell that from a bad source.
        if (
          !(error instanceof RenderedEditValidationError) ||
          error.reason === "probe_failed" ||
          signal.aborted
        ) {
          throw error;
        }
        logger.warn(
          { jobId, reason: error.reason },
          "Rendered edit failed validation, retrying with software decode"
        );
        await removeIfPresent(tempOutputPath);
        await this.runFfmpeg(
          jobId,
          sourceVideo,
          inputs,
          tempOutputPath,
          outputConfig,
          timelineConfig,
          signal,
          "sw_decode"
        );
        if (signal.aborted) throw new EditCancelledError();
        renderedDurations = await validateOutput();
      }
      await recordStageSafely(
        { scenario: "editing", videoId, jobId, mode: "process_job" },
        "validate_output",
        Date.now() - validationStart,
        { ...renderedDurations }
      );

      if (signal.aborted) throw new EditCancelledError();
      const currentJob = await editsService.getById(jobId);
      if (currentJob.status !== "running") throw new EditCancelledError();

      // Hard-link publication is atomic and refuses to replace an existing file.
      await link(tempOutputPath, finalOutputPath);
      publishedByThisJob = true;
      await removeIfPresent(tempOutputPath);
      tempOutputPath = null;

      let outputVideo: Video;
      try {
        outputVideo = await videosService.registerLocalFile(
          finalOutputPath,
          outputConfig.directory_id,
          { generateThumbnail: false }
        );
      } catch (error) {
        // The directory watcher may index the atomically-published file before
        // this method inserts it. Reuse only that exact path on a unique race.
        if (!(error instanceof ConflictError)) throw error;
        const concurrentlyIndexed =
          await videosService.findByFilePath(finalOutputPath);
        if (!concurrentlyIndexed) throw error;
        outputVideo = concurrentlyIndexed;
      }
      registeredVideoId = outputVideo.id;

      completed = await editsService.markCompleted(
        jobId,
        finalOutputPath,
        registeredVideoId
      );
      if (!completed) throw new EditCancelledError();

      thumbnailsService.generate(registeredVideoId).catch((error) => {
        logger.warn(
          { error, jobId, videoId: registeredVideoId },
          "Failed to generate thumbnail for edit output"
        );
      });
      await recordStageSafely(
        { scenario: "editing", videoId, jobId, mode: "process_job" },
        "total",
        Date.now() - totalStart,
        { segmentCount: timelineConfig.segments.length }
      );
      logger.info(
        { jobId, outputVideoId: registeredVideoId },
        "Edit job completed successfully"
      );
    } catch (error) {
      if (!completed) {
        if (registeredVideoId !== null && finalOutputPath) {
          try {
            await videosService.removeCatalogRecord(
              registeredVideoId,
              finalOutputPath
            );
          } catch (rollbackError) {
            // A failed catalog rollback can mean another edit now depends on
            // this output. Preserve its file instead of creating a broken row.
            publishedByThisJob = false;
            logger.error(
              { rollbackError, jobId, outputVideoId: registeredVideoId },
              "Failed to roll back edit output catalog entry"
            );
          }
        }
        if (publishedByThisJob) {
          try {
            await removeIfPresent(finalOutputPath);
          } catch (cleanupError) {
            logger.warn(
              { cleanupError, jobId, path: finalOutputPath },
              "Failed to remove unpublished edit output"
            );
          }
        }

        const currentJob = await editsService.getById(jobId);
        const cancelled =
          error instanceof EditCancelledError ||
          signal.aborted ||
          currentJob.status === "cancelled";
        if (!cancelled) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          logger.error({ jobId, error, errorMessage }, "Edit job failed");
          await editsService.markFailed(
            jobId,
            error instanceof RenderedEditValidationError
              ? error.message
              : "Video rendering failed"
          );
          const ffmpegProperties =
            error instanceof EditFfmpegProcessError
              ? (() => {
                  const failureKind = classifyFfmpegFailure(error.stderrOutput);
                  return {
                    ffmpegExitCode: error.exitCode,
                    ffmpegSignal: error.signal,
                    ffmpegFailureKind: failureKind,
                    encodingMode: error.encodingMode,
                    $exception_fingerprint: `edit_ffmpeg:${error.encodingMode}:${error.exitCode ?? error.signal ?? "spawn"}:${failureKind}`,
                  };
                })()
              : {};
          const validationProperties =
            error instanceof RenderedEditValidationError
              ? {
                  renderedEditValidationReason: error.reason,
                  $exception_fingerprint: `edit_output_validation:${error.reason}`,
                }
              : {};
          captureTelemetryException(error, {
            source: "edit_job",
            jobId,
            videoId,
            ...ffmpegProperties,
            ...validationProperties,
          });
        } else {
          logger.info({ jobId }, "Edit job cancelled");
        }
      }
    } finally {
      try {
        await removeIfPresent(tempOutputPath);
      } catch (cleanupError) {
        logger.warn(
          { cleanupError, jobId, path: tempOutputPath },
          "Failed to clean edit temporary output"
        );
      }
    }
  }

  private async runFfmpeg(
    jobId: number,
    sourceVideo: Video,
    inputs: EditInputs,
    outputPath: string,
    outputConfig: EditOutputConfig,
    timeline: EditTimelineConfig,
    signal: AbortSignal,
    initialMode: EditEncodingMode = "hw"
  ): Promise<void> {
    if (signal.aborted) throw new EditCancelledError();

    const sourceWidth = sourceVideo.width ?? 1920;
    const maxRate = ffmpegService.getMaxRate(sourceWidth, "av1");
    const { bitrate, maxrate, bufsize } = ffmpegService.calculateTargetBitrate(
      sourceVideo,
      {
        id: "edit_av1",
        name: "Edit AV1",
        description: "",
        targetWidth: null,
        codec: "av1_vaapi",
        qp: 34,
        maxBitrate: maxRate,
        audioBitrate: outputConfig.audio_codec === "aac" ? "128k" : "96k",
        container: "mkv",
      },
      null
    );
    const expectedDuration = calculateExpectedDuration(timeline);
    let lastProgress = 0;
    const updateProgress = (progress: number): void => {
      if (progress <= lastProgress + 2) return;
      lastProgress = progress;
      editsService.updateProgress(jobId, progress).catch((error) => {
        logger.debug(
          { error, jobId, progress },
          "Failed to persist edit progress"
        );
      });
    };

    const segmentDimensions = await probeSegmentDimensions(
      inputs.paths,
      timeline,
      signal
    );
    // VAAPI frames that change size mid-segment stall even without a graph
    // rebuild, so those segments are decoded in software.
    const mixedSize = segmentDimensions.some(hasMixedSizes);
    const mode: EditEncodingMode = mixedSize ? "sw_decode" : initialMode;
    const buildArgs = (encodingMode: EditEncodingMode): string[] =>
      buildEditFfmpegArgs({
        inputPath: sourceVideo.file_path,
        inputPaths: inputs.paths,
        outputPath,
        timeline,
        output: outputConfig,
        hasSourceAudio: inputs.hasAudio,
        sourceWidth: sourceVideo.width,
        sourceHeight: sourceVideo.height,
        sourceFps: sourceVideo.fps,
        segmentDimensions,
        vaapiDevice: env.VAAPI_DEVICE,
        bitrate,
        maxrate,
        bufsize,
        encodingMode,
      });

    logger.info(
      {
        jobId,
        segmentCount: timeline.segments.length,
        hasAudio: inputs.hasAudio,
        sources: new Set(inputs.paths).size,
        audioCodec: outputConfig.audio_codec,
        encodingMode: mode,
        seekMode: "per_segment_input",
      },
      "Starting edit FFmpeg process"
    );
    try {
      await this.executeFfmpeg(
        jobId,
        buildArgs(mode),
        expectedDuration,
        updateProgress,
        signal,
        mode
      );
    } catch (error) {
      if (
        mode !== "hw" ||
        signal.aborted ||
        error instanceof EditCancelledError ||
        !shouldRetryWithSoftwareDecode(error)
      ) {
        throw error;
      }

      logger.warn(
        {
          jobId,
          encodingMode: "sw_decode",
          seekMode: "per_segment_input",
        },
        "Retrying edit with software decode and VAAPI encode"
      );
      await removeIfPresent(outputPath);
      if (signal.aborted) throw new EditCancelledError();
      await this.executeFfmpeg(
        jobId,
        buildArgs("sw_decode"),
        expectedDuration,
        updateProgress,
        signal,
        "sw_decode"
      );
    }
  }

  /** VAAPI renders hold the GPU media lane and rerun from scratch if preempted. */
  private executeFfmpeg(
    jobId: number,
    args: string[],
    expectedDuration: number,
    onProgress: (progress: number) => void,
    signal: AbortSignal,
    encodingMode: EditEncodingMode
  ): Promise<void> {
    if (!usesVaapi(args))
      return this.spawnFfmpeg(jobId, args, expectedDuration, onProgress, signal, encodingMode);
    return gpuModes.runMedia(
      (leaseSignal) =>
        this.spawnFfmpeg(jobId, args, expectedDuration, onProgress, leaseSignal, encodingMode),
      { label: `Edit job ${jobId}`, signal }
    );
  }

  private spawnFfmpeg(
    jobId: number,
    args: string[],
    expectedDuration: number,
    onProgress: (progress: number) => void,
    signal: AbortSignal,
    encodingMode: EditEncodingMode
  ): Promise<void> {
    if (signal.aborted) return Promise.reject(new EditCancelledError());

    return new Promise((resolvePromise, rejectPromise) => {
      const ffmpeg = spawn(env.FFMPEG_PATH, args, {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let settled = false;
      let progressBuffer = "";
      let stderrTail = "";
      let lastOutTime = -1;
      let lastAdvanceAt = Date.now();
      let stalled = false;
      // A deadlocked filter graph keeps ffmpeg alive while it buffers decoded
      // input without bound, so stop a render whose output stops advancing.
      const stallWatchdog = setInterval(() => {
        if (Date.now() - lastAdvanceAt < EDIT_FFMPEG_STALL_MS) return;
        stalled = true;
        terminateProcess(ffmpeg);
      }, 10_000);

      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearInterval(stallWatchdog);
        signal.removeEventListener("abort", onAbort);
        if (error) rejectPromise(error);
        else resolvePromise();
      };
      const onAbort = () => terminateProcess(ffmpeg);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();

      ffmpeg.stdout.on("data", (data: Buffer) => {
        progressBuffer += data.toString();
        const lines = progressBuffer.split(/\r?\n/);
        progressBuffer = lines.pop() ?? "";
        for (const line of lines) {
          const match = /^out_time_(?:ms|us)=(\d+)$/.exec(line);
          if (!match) continue;
          const seconds = Number.parseInt(match[1], 10) / 1_000_000;
          if (seconds > lastOutTime) {
            lastOutTime = seconds;
            lastAdvanceAt = Date.now();
          }
          if (expectedDuration <= 0) continue;
          const progress = Math.min(
            99,
            Math.round((seconds / expectedDuration) * 100)
          );
          onProgress(progress);
        }
      });

      ffmpeg.stderr.on("data", (data: Buffer) => {
        stderrTail = `${stderrTail}${data.toString()}`.slice(-8_000);
      });
      ffmpeg.on("close", (code, closeSignal) => {
        if (signal.aborted) {
          settle(new EditCancelledError());
        } else if (stalled) {
          settle(
            new EditFfmpegProcessError(
              `FFmpeg edit stalled: no output progress for ${EDIT_FFMPEG_STALL_MS / 1000}s`,
              stderrTail.trim(),
              code,
              closeSignal,
              encodingMode
            )
          );
        } else if (code === 0) {
          logger.info(
            { jobId, encodingMode, seekMode: "per_segment_input" },
            "Edit FFmpeg process completed"
          );
          settle();
        } else {
          const failureKind = classifyFfmpegFailure(stderrTail);
          settle(
            new EditFfmpegProcessError(
              `FFmpeg edit failed (${failureKind}) with exit code ${code ?? "unknown"}`,
              stderrTail.trim(),
              code,
              closeSignal,
              encodingMode
            )
          );
        }
      });
      ffmpeg.on("error", (error) => {
        settle(
          new EditFfmpegProcessError(
            "FFmpeg edit process failed to start",
            stderrTail.trim(),
            null,
            null,
            encodingMode,
            { cause: error }
          )
        );
      });
    });
  }
}

export const editsProcessor = new EditsProcessor();
