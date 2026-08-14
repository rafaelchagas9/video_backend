import { spawn } from "child_process";
import { env } from "@/config/env";

const RENDER_DURATION_TOLERANCE_SECONDS = 0.5;
const MAX_FFPROBE_OUTPUT_BYTES = 1_000_000;
const FFPROBE_TIMEOUT_MS = 30_000;

export interface EditProbeStream {
  codec_type?: string;
  start_time?: number | string;
  duration?: number | string;
  tags?: Record<string, unknown>;
}

export interface EditProbeData {
  streams?: EditProbeStream[];
  format?: {
    duration?: number | string;
  };
}

export interface RenderedEditDurations {
  expectedDuration: number;
  containerDuration: number;
  videoDuration: number;
  audioDuration: number | null;
  audioEnd: number | null;
  expectsAudio: boolean;
}

export class RenderedEditValidationError extends Error {
  readonly name = "RenderedEditValidationError";

  constructor(
    message: string,
    readonly reason:
      | "probe_failed"
      | "invalid_probe"
      | "missing_video"
      | "missing_audio"
      | "unexpected_audio"
      | "video_duration_mismatch"
      | "audio_duration_mismatch"
  ) {
    super(message);
    Object.setPrototypeOf(this, RenderedEditValidationError.prototype);
  }
}

export function parseProbeNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseClockDuration(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(value.trim());
  if (!match) return null;
  const hours = Number.parseInt(match[1]!, 10);
  const minutes = Number.parseInt(match[2]!, 10);
  const seconds = Number.parseFloat(match[3]!);
  if (minutes >= 60 || seconds >= 60) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

export function getProbeStreamDuration(stream: EditProbeStream): number | null {
  const direct = parseProbeNumber(stream.duration);
  if (direct !== null) return direct;
  return parseClockDuration(stream.tags?.DURATION ?? stream.tags?.duration);
}

export function getProbeStreamStart(stream: EditProbeStream): number | null {
  return parseProbeNumber(stream.start_time);
}

function assertDurationMatches(
  actual: number,
  expected: number,
  kind: "video" | "audio",
  toleranceSeconds: number
): void {
  if (Math.abs(actual - expected) <= toleranceSeconds) return;
  throw new RenderedEditValidationError(
    `Rendered ${kind} duration does not match the requested edit duration`,
    kind === "video" ? "video_duration_mismatch" : "audio_duration_mismatch"
  );
}

export function validateRenderedEditProbe(
  probe: EditProbeData,
  expectedDuration: number,
  expectsAudio: boolean,
  toleranceSeconds = RENDER_DURATION_TOLERANCE_SECONDS
): RenderedEditDurations {
  const streams = probe.streams ?? [];
  const videoStreams = streams.filter(
    (stream) => stream.codec_type === "video"
  );
  const audioStreams = streams.filter(
    (stream) => stream.codec_type === "audio"
  );
  if (videoStreams.length === 0) {
    throw new RenderedEditValidationError(
      "Rendered edit has no video stream",
      "missing_video"
    );
  }
  if (videoStreams.length !== 1 || audioStreams.length > 1) {
    throw new RenderedEditValidationError(
      "Rendered edit has an unexpected stream layout",
      "invalid_probe"
    );
  }
  const video = videoStreams[0]!;

  const containerDuration = parseProbeNumber(probe.format?.duration);
  const videoDuration = getProbeStreamDuration(video) ?? containerDuration;
  if (containerDuration === null || videoDuration === null) {
    throw new RenderedEditValidationError(
      "Rendered edit duration could not be inspected",
      "invalid_probe"
    );
  }
  assertDurationMatches(
    containerDuration,
    expectedDuration,
    "video",
    toleranceSeconds
  );
  assertDurationMatches(
    videoDuration,
    expectedDuration,
    "video",
    toleranceSeconds
  );

  const audio = audioStreams[0];
  if (expectsAudio && !audio) {
    throw new RenderedEditValidationError(
      "Rendered edit has no audio stream",
      "missing_audio"
    );
  }
  if (!expectsAudio && audio) {
    throw new RenderedEditValidationError(
      "Rendered edit unexpectedly contains audio",
      "unexpected_audio"
    );
  }
  const audioDuration = audio ? getProbeStreamDuration(audio) : null;
  const audioStart = audio ? (getProbeStreamStart(audio) ?? 0) : null;
  const audioEnd =
    audioStart !== null && audioDuration !== null
      ? audioStart + audioDuration
      : null;
  if (expectsAudio) {
    if (audioDuration === null || audioEnd === null) {
      throw new RenderedEditValidationError(
        "Rendered audio duration could not be inspected",
        "invalid_probe"
      );
    }
    assertDurationMatches(
      audioDuration,
      expectedDuration,
      "audio",
      toleranceSeconds
    );
    assertDurationMatches(audioEnd, videoDuration, "audio", toleranceSeconds);
  }

  return {
    expectedDuration,
    containerDuration,
    videoDuration,
    audioDuration,
    audioEnd,
    expectsAudio,
  };
}

export function probeRenderedEditOutput(
  outputPath: string,
  expectedDuration: number,
  expectsAudio: boolean,
  signal?: AbortSignal
): Promise<RenderedEditDurations> {
  const args = [
    "-v",
    "error",
    "-show_entries",
    "format=duration:stream=codec_type,start_time,duration:stream_tags=DURATION",
    "-of",
    "json",
    outputPath,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(env.FFPROBE_PATH, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let outputTooLarge = false;
    let settled = false;

    const finish = (
      result:
        | { ok: true; durations: RenderedEditDurations }
        | { ok: false; error: RenderedEditValidationError }
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      if (result.ok) resolve(result.durations);
      else reject(result.error);
    };
    const stopProbe = () => {
      if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
    };
    const onAbort = () => {
      stopProbe();
      finish({
        ok: false,
        error: new RenderedEditValidationError(
          "Rendered edit inspection was cancelled",
          "probe_failed"
        ),
      });
    };
    const timeout = setTimeout(() => {
      stopProbe();
      finish({
        ok: false,
        error: new RenderedEditValidationError(
          "Rendered edit inspection timed out",
          "probe_failed"
        ),
      });
    }, FFPROBE_TIMEOUT_MS);
    timeout.unref();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();

    child.stdout.on("data", (chunk: Buffer) => {
      if (outputTooLarge) return;
      stdout += chunk.toString();
      if (stdout.length > MAX_FFPROBE_OUTPUT_BYTES) {
        outputTooLarge = true;
        child.kill("SIGKILL");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_FFPROBE_OUTPUT_BYTES) {
        stderr += chunk.toString();
      }
    });
    child.on("error", () => {
      finish({
        ok: false,
        error: new RenderedEditValidationError(
          "Rendered edit could not be inspected",
          "probe_failed"
        ),
      });
    });
    child.on("close", (code) => {
      if (code !== 0 || outputTooLarge) {
        finish({
          ok: false,
          error: new RenderedEditValidationError(
            stderr.trim()
              ? "Rendered edit probe failed"
              : "Rendered edit could not be inspected",
            "probe_failed"
          ),
        });
        return;
      }

      try {
        const probe = JSON.parse(stdout) as EditProbeData;
        finish({
          ok: true,
          durations: validateRenderedEditProbe(
            probe,
            expectedDuration,
            expectsAudio
          ),
        });
      } catch (error) {
        finish({
          ok: false,
          error:
            error instanceof RenderedEditValidationError
              ? error
              : new RenderedEditValidationError(
                  "Rendered edit probe returned invalid data",
                  "invalid_probe"
                ),
        });
      }
    });
  });
}
